import express from 'express';
import cors from 'cors';
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Metaplex } from '@metaplex-foundation/js';
import 'dotenv/config';
import multer from 'multer';
import { PinataSDK } from 'pinata';

// --- Constants ---
const PORT = process.env.PORT || 3000;

// --- App setup ---
const app = express();
app.use(cors());
app.use(express.json());

const pinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.PINATA_GATEWAY,
});

const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload", upload.fields([
  { name: "image", maxCount: 1 },
  { name: "extraFile", maxCount: 1 }
]), async (req, res) => {
  try {
    const prev = req.body.prev || "default-prev";
    const imageFile = req.files.image?.[0];
    const extraFile = req.files.extraFile?.[0];

    if (!imageFile) return res.status(400).json({ error: "Image file is required" });

    // Upload image
    const img = new File([imageFile.buffer], imageFile.originalname, { type: imageFile.mimetype });
    const imgUpload = await pinata.upload.public.file(img);

    let extraUpload = null;
    if (extraFile) {
      const extra = new File([extraFile.buffer], extraFile.originalname, { type: extraFile.mimetype });
      extraUpload = await pinata.upload.public.file(extra);
    }

    // Build JSON
    const metadataJson = {
      name: "42 Campus Change",
      symbol: "42CC",
      description: "by tde-cama",
      seller_fee_basis_points: 500,
      image: `https://gateway.pinata.cloud/ipfs/${imgUpload.cid}`,
      attributes: [{ trait_type: "type", value: "value" }],
      properties: {
        category: "image",
        files: [
          { uri: `https://gateway.pinata.cloud/ipfs/${imgUpload.cid}`, type: imageFile.mimetype }
        ]
      },
      creators: [{ address: "5BLB4bV8aL8h7cyRaUWEu6x4FLP4XGCBJ6DSYrXjNZXM", verified: true, share: 100 }],
      prev
    };

    if (extraUpload) {
      metadataJson.properties.files.push({
        uri: `https://gateway.pinata.cloud/ipfs/${extraUpload.cid}`,
        type: extraFile.mimetype
      });
    }

    // Upload JSON
    const jsonUpload = await pinata.upload.public.json(metadataJson, { name: "nft-metadata.json" });

    res.json({
      message: "JSON uploaded successfully",
      metadataCid: jsonUpload.cid,
      metadataUrl: `https://gateway.pinata.cloud/ipfs/${jsonUpload.cid}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// --- Routes ---
// Root
app.get('/', (req, res) => res.send('Solana NFT Minting API running'));

// Fetch NFT metadata
app.get('/metadata/:mint', async (req, res) => {
  try {
    const mint = new PublicKey(req.params.mint);
    const nft = await metaplex.nfts().findByMint({ mintAddress: mint });
    res.json({ success: true, metadata: nft });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
