import express, { Request, Response } from 'express';
import { ReclaimClient } from './zk-fetch';
import { Reclaim } from '@reclaimprotocol/js-sdk';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
dotenv.config();


const wallet = ethers.Wallet.createRandom();
const privateKey = wallet.privateKey;
const reclaimClient = new ReclaimClient(privateKey);
const app = express();


app.get('/', (_: Request, res: Response) => {
    res.send('gm gm! api is running');
});

app.get('/generateProof', async (_: Request, res: Response) => {
    try {
        // URL to fetch the data from - in this case, the price of Ethereum in USD from the CoinGecko API
        const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
        
        const proof = await reclaimClient.zkFetch(url, {
            // public options for the fetch request 
            method: 'GET',
        }, {
            // options for the proof generation
            responseMatches: [
                {
                    "type": "regex",
                    "value": "\\{\"ethereum\":\\{\"usd\":(?<price>[\\d\\.]+)\\}\\}"
                }
            ],
        });
      
        if (!proof) {
            return res.status(400).send('Failed to generate proof');
        }
        
        // Verify the proof
        const isValid = await Reclaim.verifySignedProof(proof);
        if (!isValid) {
            return res.status(400).send('Proof is invalid');
        }
        
        // Transform the proof data to be used on-chain (for the contract)
        const proofData = await Reclaim.transformForOnchain(proof);
        return res.status(200).json({ transformedProof: proofData, proof });
    } catch (e) {
        console.error(e);
        return res.status(500).send(e instanceof Error ? e.message : 'An unknown error occurred');
    }
});



const PORT = process.env.PORT || 8080;

// Start server
app.listen(PORT, () => {
  console.log(`App is listening on port ${PORT}`);
});