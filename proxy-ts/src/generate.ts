import { generateProof, verifyProof, makeLocalSnarkJsZkOperator } from '@reclaimprotocol/circom-symmetric-crypto';

interface PacketReveal {
  key: number[];
  iv: number[];
  recordNumber: number;
}

async function generateProofForPacket(packetNumber: number, reveal: PacketReveal) {
  try {
    const operator = await makeLocalSnarkJsZkOperator('chacha20');

    // Note: We don't have the actual ciphertext in the provided data,
    // so we're using a placeholder. In a real scenario, you'd use the actual ciphertext.
    const dummyCiphertext = Buffer.from('dummy ciphertext');

    const { proofJson, plaintext } = await generateProof({
      algorithm: 'chacha20',
      privateInput: {
        key: Buffer.from(reveal.key),
        // iv: Buffer.from(reveal.iv),
        // offset: reveal.recordNumber
      },
      publicInput: {
          ciphertext: dummyCiphertext,
          iv: Buffer.from(reveal.iv),
          offset: reveal.recordNumber
      },
      operator,
    });


    console.log(proofJson)
    // Verify the proof
    await verifyProof({
      proof: {
        proofJson,
        plaintext,
        algorithm: 'chacha20'
      },
      publicInput: {
        ciphertext: dummyCiphertext,
        iv: Buffer.from(reveal.iv),
        offset: reveal.recordNumber
    },
      operator
    });

    console.log(`Proof generated and verified for packet ${packetNumber}`);
    return { packetNumber, proofJson, plaintext };
  } catch (error) {
    console.error(`Error generating proof for packet ${packetNumber}:`, error);
    return null;
  }
}

async function main() {
  const packets: [number, PacketReveal][] = [
    [4, { key: [162,171,62,151,168,34,53,168,108,204,31,31,81,1,212,171,47,211,244,135,203,37,105,76,117,24,19,186,187,98,160,214], iv: [219,70,69,45,185,110,23,72,246,141,137,244], recordNumber: 0 }],
    [5, { key: [40,33,83,127,114,20,19,181,39,147,211,101,21,70,7,104,132,201,65,251,73,150,36,63,41,199,94,253,114,36,112,53], iv: [6,32,181,224,249,186,28,17,178,43,183,226], recordNumber: 0 }],
    [6, { key: [190,178,171,200,87,94,1,207,19,104,19,221,14,167,138,65,12,48,165,25,31,181,5,95,134,30,191,163,36,84,238,224], iv: [12,201,169,23,61,5,103,60,168,61,187,59], recordNumber: 0 }],
    [7, { key: [50,131,43,21,1,151,173,93,220,70,222,48,48,79,240,2,231,123,186,4,203,100,167,85,211,19,74,19,191,75,18,241], iv: [72,165,24,42,43,19,107,60,133,67,111,117], recordNumber: 0 }],
    [11, { key: [201,129,83,35,155,35,41,137,121,32,24,13,164,16,138,82,39,67,153,38,204,194,102,31,91,149,1,153,210,8,23,220], iv: [99,50,74,200,31,191,23,3,37,229,134,223], recordNumber: 0 }],
    [12, { key: [127,146,243,31,125,175,79,142,57,164,156,181,7,213,140,51,247,160,16,57,21,6,97,51,11,116,61,184,102,217,190,245], iv: [135,235,91,185,236,155,94,22,90,217,134,141], recordNumber: 0 }],
    [13, { key: [127,146,243,31,125,175,79,142,57,164,156,181,7,213,140,51,247,160,16,57,21,6,97,51,11,116,61,184,102,217,190,245], iv: [135,235,91,185,236,155,94,22,90,217,134,141], recordNumber: 1 }],
    [14, { key: [127,146,243,31,125,175,79,142,57,164,156,181,7,213,140,51,247,160,16,57,21,6,97,51,11,116,61,184,102,217,190,245], iv: [135,235,91,185,236,155,94,22,90,217,134,141], recordNumber: 2 }],
    [15, { key: [127,146,243,31,125,175,79,142,57,164,156,181,7,213,140,51,247,160,16,57,21,6,97,51,11,116,61,184,102,217,190,245], iv: [135,235,91,185,236,155,94,22,90,217,134,141], recordNumber: 3 }]
  ];

  const proofs = await Promise.all(packets.map(([packetNumber, reveal]) => 
    generateProofForPacket(packetNumber, reveal)
  ));

  console.log(`Generated ${proofs.filter(Boolean).length} proofs`);
}

main().catch(console.error);