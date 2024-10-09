import { makeTLSClient, strToUint8Array } from '@reclaimprotocol/tls';
import { Socket } from 'net';

async function performTLSRequest(host: string, port: number, path: string) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let responseData = new Uint8Array();

    const tls = makeTLSClient({
      host,
      verifyServerCertificate: false, // Note: Only disable for testing
      supportedProtocolVersions: ['TLS1_3'],
      onApplicationData: (data) => {
        responseData = new Uint8Array([...responseData, ...data]);
      },
      async write({ header, content }) {
        socket.write(header);
        socket.write(content);
      },
    });

    socket.on('data', tls.handleReceivedBytes);
    socket.on('connect', () => tls.startHandshake());

    socket.on('error', (error) => {
      reject(error);
    });

    socket.connect({ host, port });

    const waitForHandshake = async () => {
      while (!tls.isHandshakeDone()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };

    waitForHandshake().then(async () => {
      console.log('TLS Handshake completed');

      const request = strToUint8Array(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n\r\n`
      );
      await tls.write(request);

      // Wait for the response
      setTimeout(() => {
        const sessionId = tls.getSessionId();
        const keys = tls.getKeys();
        const metadata = tls.getMetadata();

        console.log('Session ID:', sessionId);
        console.log('Keys:', keys);
        console.log('Metadata:', metadata);

        const decoder = new TextDecoder();
        console.log('Response:', decoder.decode(responseData));

        socket.end();
        tls.end().then(() => {
          resolve({
            response: responseData,
            sessionId,
            keys,
            metadata
          });
        });
      }, 1000); // Adjust timeout as needed
    }).catch(reject);
  });
}

// Usage
const host = 'google.com';
const port = 443;
const path = '/';

performTLSRequest(host, port, path)
  .then((result) => {
    console.log('Request completed successfully');
    // Here you would use the result to generate your ZK proofs
  })
  .catch((error) => {
    console.error('An error occurred:', error);
  });