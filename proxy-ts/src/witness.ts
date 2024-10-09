import { createClaimOnWitness, CreateClaimOnWitnessOpts, WitnessClient, } from '@reclaimprotocol/witness-sdk'
import { ReclaimClient } from "@reclaimprotocol/zk-fetch";
import { Reclaim } from "@reclaimprotocol/js-sdk";
import { ethers } from 'ethers';

const wallet = ethers.Wallet.createRandom();
const privateKey = wallet.privateKey;

const XApiParams: CreateClaimOnWitnessOpts<"http"> = {
  name: "http",
  params: {
    url: "https://api.stablepay.ai", // Assuming this is the correct endpoint
    method: "GET",
    responseRedactions: [], // We don't need to redact anything in this case
    responseMatches: [
      {
        type: "contains",
        value: "This is the Stable Pay API"
      }
    ],
    headers: {
      "Accept": "application/json",
      "User-Agent": "Reclaim-Verify/1.0"
    }
  },
  secretParams: {
    headers: {
      // Add a dummy header to satisfy the auth requirement
      "X-Dummy-Auth": "dummy-value"
    }
  }, // No secret params needed for this public API call
  context: {
    purpose: "Verify StablePay API response"
  },
  ownerPrivateKey: privateKey, // Replace with actual private key
  client: new WitnessClient({ url: 'wss://witness.reclaimprotocol.org/ws' }),
  zkEngine: 'snarkJS',
  onStep: (step) => {
    console.log(`Current step: ${step.name}`)
  },
  timestampS: Math.floor(Date.now() / 1000)
}

async function createXApiClaim(privateKey: string) {
  try {
    const reclaimClient = new ReclaimClient(process.env.APP_ID!, process.env.APP_SECRET!);

    const result = await createClaimOnWitness({
      ...XApiParams,
      ownerPrivateKey: privateKey,
    });

    console.log('Claim created successfully:', result);

    // Extract the Groth16 proof
    const groth16Proof = extractGroth16Proof(result);
    if (groth16Proof) { 
      console.log('Groth16 Proof:', groth16Proof);
      // Here you can use the Groth16 proof for further processing or verification
    } else {
      console.log('Groth16 Proof not found in the claim');
    }
    return result;
  } catch (error) {
    console.error('Error creating claim:', error);
    throw error;
  }
}

function extractGroth16Proof(claim: any): any | null {
  if (claim && claim.request && claim.request.transcript) {
    for (const item of claim.request.transcript) {
      if (item.reveal && item.reveal.zkReveal) {
        // This is likely where the Groth16 proof is stored
        return item.reveal.zkReveal;
      }
    }
  }
  return null;
}

async function runClaimCreation() {
  try {
    const claim = await createXApiClaim(privateKey);
    console.log('Claim details:', claim);
    // Here you can do something with the claim, like saving it or using it to prove the API response
  } catch (error) {
    console.error('Failed to create claim:', error);
  }
}

// Run the function
runClaimCreation();
