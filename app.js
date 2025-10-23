import express from 'express';
import cors from 'cors';
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Metaplex } from '@metaplex-foundation/js';
import 'dotenv/config';
import idl from './idl.json' with { type: 'json' };
import multer from 'multer';
import { PinataSDK } from 'pinata';

// --- Constants ---
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = process.env.PROGRAM_ID;

// --- App setup ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Solana setup ---
const connection = new Connection(RPC_URL);
const wallet = anchor.Wallet.local();
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
anchor.setProvider(provider);
const PROGRAM_ID_PUBKEY = new PublicKey(PROGRAM_ID);

console.log(PROGRAM_ID_PUBKEY.toBase58())

// --- IDL & Program ---
// const program = new anchor.Program(idl, PROGRAM_ID_PUBKEY, provider);

// --- Metaplex setup ---
const metaplex = new Metaplex(connection);

// --- Base constants ---
const METADATA_SEED = 'metadata';
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const COLLECTION_ID = 123456789;

const toNumberBuffer = (number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(number), 0);
  return buffer;
};

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
