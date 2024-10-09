import { CipherSuite, concatenateUint8Arrays, crypto, TLSPacketContext } from '@reclaimprotocol/tls'
import {
	ClaimTunnelRequest_TranscriptMessage as TranscriptMessage,
	TranscriptMessageSenderType
} from '@reclaimprotocol/witness-sdk/lib/proto/api'
import { CompleteTLSPacket, Logger, MessageRevealInfo, PrepareZKProofsBaseOpts, Transcript } from '@reclaimprotocol/witness-sdk'
import { makeZkProofGenerator } from '@reclaimprotocol/witness-sdk'

export type PreparePacketsForRevealOpts = {
	cipherSuite: CipherSuite
	logger: Logger
	/**
	 * Progress of Zk proof generation
	 */
	onZkProgress?(blocksDone: number, totalBlocks: number): void
} & PrepareZKProofsBaseOpts

/**
 * Prepares the packets for reveal to the server
 * according to the specified reveal type
 */
export async function preparePacketsForReveal(
    tlsTranscript: Transcript<CompleteTLSPacket>,
    reveals: Map<TLSPacketContext, MessageRevealInfo>,
    { onZkProgress, ...opts }: PreparePacketsForRevealOpts
  ) {
    console.log('Starting preparePacketsForReveal');
    console.log('TLS Transcript length:', tlsTranscript.length);
    console.log('Reveals map size:', reveals.size);
  
    const transcript: TranscriptMessage[] = []
    const proofGenerator = await makeZkProofGenerator(opts)
    console.log('Proof generator created');
  
    let zkPacketsDone = 0
  
    await Promise.all(tlsTranscript.map(async(packet: any, index: number) => {
      console.log(`Processing packet ${index + 1}/${tlsTranscript.length}`);
      const { message, sender } = packet;
      const msg: TranscriptMessage = {
        sender: sender === 'client'
          ? TranscriptMessageSenderType.TRANSCRIPT_MESSAGE_SENDER_TYPE_CLIENT
          : TranscriptMessageSenderType.TRANSCRIPT_MESSAGE_SENDER_TYPE_SERVER,
        message: message.data,
        reveal: undefined
      }
      transcript.push(msg)
  
      const reveal = reveals.get(message)
      if(!reveal || message.type === 'plaintext') {
        console.log(`Packet ${index + 1}: No reveal needed`);
        return
      }
  
      console.log(`Packet ${index + 1}: Reveal type:`, reveal.type);
      switch (reveal.type) {
      case 'complete':
        msg.reveal = {
          directReveal: {
            key: await crypto.exportKey(message.encKey),
            iv: message.fixedIv,
            recordNumber: message.recordNumber,
          },
        }
        console.log(`Packet ${index + 1}: Complete reveal:`, msg.reveal);
        break
      case 'zk':
        reveal.redactedPlaintext = concatenateUint8Arrays([
          reveal.redactedPlaintext,
          message.plaintext.slice(reveal.redactedPlaintext.length)
        ])
  
        console.log(`Packet ${index + 1}: Adding packet to prove`);
        await proofGenerator.addPacketToProve(
          message,
          reveal,
          (proofs: any) => {
            msg.reveal = { zkReveal: { proofs } }
            console.log(`Packet ${index + 1}: ZK reveal proofs:`, JSON.stringify(proofs, null, 2));
          }
        )
        break
      default:
        console.log(`Packet ${index + 1}: Unknown reveal type`);
        break
      }
    }))
  
    const zkPacketsTotal = proofGenerator.getTotalChunksToProve()
    console.log(`Total ZK packets to prove: ${zkPacketsTotal}`);
  
    console.log('Starting to generate proofs');
    await proofGenerator.generateProofs(
      () => {
        zkPacketsDone += 1
        onZkProgress?.(zkPacketsDone, zkPacketsTotal)
        console.log(`ZK proof progress: ${zkPacketsDone}/${zkPacketsTotal}`);
      }
    )
  
    console.log('Transcript preparation complete');
    console.log('Final transcript length:', transcript.length);
  
 
    return transcript
  }