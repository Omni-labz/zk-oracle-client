import { Keypair, PublicKey } from "@solana/web3.js";
import { ServiceSignatureProvider } from "@reclaimprotocol/witness-sdk";
import nacl from "tweetnacl";
import bs58 from 'bs58';

export const SOL_SIGNATURE_PROVIDER: ServiceSignatureProvider = {
    getPublicKey(privateKey: string) {
        const pkeyBs58 = bs58.decode(privateKey)
        const keypair = Keypair.fromSecretKey(pkeyBs58);
        const publicKey = keypair.publicKey;
        return publicKey.toBytes();
    },
    getAddress(publicKeyUint8Array: Uint8Array) {
		const publicKey = new PublicKey(publicKeyUint8Array);
        const bs58String = publicKey.toBase58();
        return bs58String;
	},
    async sign(data: Uint8Array, privateKey) {
		const pkeyBs58 = bs58.decode(privateKey)
        const wallet = Keypair.fromSecretKey(pkeyBs58);
		const messageToSign = data;
		const signature = nacl.sign.detached(messageToSign, wallet.secretKey);
        return new Uint8Array(signature);
	},
    async verify(data: Uint8Array,
        signature: Uint8Array,
        addressBytes: Uint8Array) {

		// If publicKey is a PublicKey object, convert it to Uint8Array
        const publicKeyBytes = addressBytes instanceof PublicKey
        ? addressBytes.toBytes()
        : addressBytes;

        return nacl.sign.detached.verify(data, signature, publicKeyBytes);
	}
}