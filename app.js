import express from 'express';
import cors from 'cors';
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Metaplex } from '@metaplex-foundation/js';
import 'dotenv/config';
import idl from './secrets/idl.json' with { type: 'json' };
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
const PROGRAM_ID_PUBKEY = new anchor.web3.PublicKey(PROGRAM_ID);

// --- IDL & Program ---
const program = new anchor.Program(idl, PROGRAM_ID_PUBKEY);

// --- Metaplex setup ---
const metaplex = Metaplex.make(connection);

// --- Pinata setup ---
const pinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.PINATA_GATEWAY,
});

const upload = multer({ storage: multer.memoryStorage() });

// --- Base constants (MUST MATCH YOUR TEST EXACTLY) ---
const METADATA_SEED = 'metadata';
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const MINT_SEED = '8b823f49ba';
const COLLECTION_ID = 123456789;

const toNumberBuffer = (number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(number), 0);
  return buffer;
};

// --- Routes ---
app.get('/', (req, res) => res.send('Solana NFT Minting API running'));

// Fix the metadata route to use query parameters
app.get('/metadata', async (req, res) => {
  try {
    const { mint } = req.query;
    
    if (!mint) {
      return res.status(400).json({ success: false, error: "Mint address is required" });
    }
    
    console.log("Fetching metadata for mint:", mint);
    
    const mintKey = new PublicKey(mint);
    const nft = await metaplex.nfts().findByMint({ mintAddress: mintKey });
    res.json({ success: true, metadata: nft });
  } catch (err) {
    console.error("Error fetching metadata:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// SINGLE CALL: Upload to Pinata + Mint NFT
app.post("/upload-and-mint", upload.fields([
  { name: "image", maxCount: 1 },
  { name: "extraFile", maxCount: 1 }
]), async (req, res) => {
  try {
    const { name = "IceCream_NFT", symbol = "UNLVR", description = "", collection_id = "MK_00", prev = "null" } = req.body;
    const imageFile = req.files.image?.[0];
    const extraFile = req.files.extraFile?.[0];

    if (!imageFile) {
      return res.status(400).json({ error: "Image file is required" });
    }

    console.log("📤 Step 1: Uploading files to Pinata...");

    // 1. Upload image to Pinata
    const img = new File([imageFile.buffer], imageFile.originalname, { type: imageFile.mimetype });
    const imgUpload = await pinata.upload.public.file(img);

    let extraUpload = null;
    if (extraFile) {
      const extra = new File([extraFile.buffer], extraFile.originalname, { type: extraFile.mimetype });
      extraUpload = await pinata.upload.public.file(extra);
    }

    console.log("✅ Files uploaded to Pinata");

    // 2. Create metadata JSON with Pinata URLs AND THE PREV FIELD
    const metadataJson = {
      name,
      symbol,
      description,
      seller_fee_basis_points: 500,
      image: `https://gateway.pinata.cloud/ipfs/${imgUpload.cid}`,
      attributes: [{ trait_type: "type", value: "value" }],
      properties: {
        category: "image",
        files: [
          { uri: `https://gateway.pinata.cloud/ipfs/${imgUpload.cid}`, type: imageFile.mimetype }
        ]
      },
      creators: [{ 
        address: wallet.publicKey.toString(), 
        verified: true, 
        share: 100 
      }],
      prev
    };

    if (extraUpload) {
      metadataJson.properties.files.push({
        uri: `https://gateway.pinata.cloud/ipfs/${extraUpload.cid}`,
        type: extraFile.mimetype
      });
    }

    // 3. Upload metadata JSON to Pinata
    console.log("📝 Step 2: Uploading metadata JSON to Pinata...");
    const jsonUpload = await pinata.upload.public.json(metadataJson, { name: "nft-metadata.json" });
    const metadataUri = `https://gateway.pinata.cloud/ipfs/${jsonUpload.cid}`;
    
    console.log("✅ Metadata uploaded to Pinata:", metadataUri);
    console.log("📋 Prev field in metadata:", prev);

    // 4. Mint NFT with the metadata URI (EXACTLY LIKE YOUR TEST)
    console.log("🎨 Step 3: Minting NFT with metadata URI...");
    
    const [mint] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_SEED), Buffer.from(collection_id)],
      program.programId
    );

    const [metadataAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    const [masterEditionAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
        Buffer.from("edition"),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

    const destination = await anchor.utils.token.associatedAddress({
      mint,
      owner: wallet.publicKey,
    });

    // Check if mint already exists (like your test)
    const info = await connection.getAccountInfo(mint);
    if (info) {
      throw new Error("Mint already exists");
    }

    console.log("  Mint not found. Initializing NFT...");

    // Context matching your test EXACTLY
    const context = {
      mint: mint,
      payer: wallet.publicKey,
      destination: destination,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      metadata: metadataAddress,
      masterEdition: masterEditionAddress,
    };

    console.log("📝 Accounts setup complete, sending transaction...");

    // Transaction matching your test EXACTLY
    const tx = await program.methods
      .createNft(
        { 
          name, 
          symbol, 
          uri: metadataUri,
          sellerFeeBasisPoints: 500 
        }, 
        collection_id
      )
      .accounts(context)
      .transaction();

    const txHash = await anchor.web3.sendAndConfirmTransaction(
      connection, 
      tx, 
      [wallet.payer],
      { skipPreflight: true } // LIKE YOUR TEST
    );

    console.log("✅ NFT minted successfully!");
    console.log("Transaction:", txHash);
    console.log("Mint address:", mint.toString());

    // 5. Return all results with explorer links
    const explorerBaseUrl = 'https://explorer.solana.com';
    const mintAddress = mint.toString();

    res.json({
      success: true,
      message: "NFT created and minted successfully in one call",
      imageUrl: `https://gateway.pinata.cloud/ipfs/${imgUpload.cid}`,
      metadataUrl: metadataUri,
      mint: mintAddress,
      txHash,
      explorerLink: `${explorerBaseUrl}/address/${mintAddress}?cluster=devnet`,
      transactionLink: `${explorerBaseUrl}/tx/${txHash}?cluster=devnet`,
      extraFileUrl: extraUpload ? `https://gateway.pinata.cloud/ipfs/${extraUpload.cid}` : null,
      prev: prev
    });

  } catch (err) {
    console.error("❌ Upload and mint failed:", err);
    res.status(500).json({ 
      error: "Upload and mint failed", 
      details: err.message 
    });
  }
});

app.get("/recent-batch", async (req, res) => {
  try {
    const firstUrl = "https://gateway.pinata.cloud/ipfs/bafkreib2sr2lsaqtsxsxkgpgcajxh5henxuc7v7uffo7eplnf3vvqxpwem";
    const res1 = await fetch(firstUrl);
    if (!res1.ok) throw new Error("Failed to fetch first IPFS file");
    const data1 = await res1.json();

    const secondUri = data1?.properties?.files?.[1]?.uri;
    if (!secondUri) throw new Error("URI not found at properties.files[1].uri");

    const res2 = await fetch(secondUri);
    if (!res2.ok) throw new Error("Failed to fetch nested JSON");
    const data2 = await res2.json();

    res.json({ success: true, data: data2 });
  } catch (err) {
    console.error("Error fetching recent batch:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get NFT chain by following prev links
app.get('/nft-chain', async (req, res) => {
  try {
    const { mint } = req.query;
    
    if (!mint) {
      return res.status(400).json({ success: false, error: "Mint address is required" });
    }
    
    console.log("🔗 Building NFT chain starting from:", mint);
    
    const chain = [];
    let currentMint = mint;
    let visited = new Set(); // Prevent infinite loops
    
    while (currentMint && currentMint !== "null" && !visited.has(currentMint)) {
      try {
        visited.add(currentMint);
        
        console.log(`📥 Fetching metadata for: ${currentMint}`);
        const mintKey = new PublicKey(currentMint);
        const nft = await metaplex.nfts().findByMint({ mintAddress: mintKey });
        
        // Fetch the actual metadata from the URI
        let metadata = {};
        let secondFileData = null;
        
        if (nft.uri) {
          const metadataResponse = await fetch(nft.uri);
          if (metadataResponse.ok) {
            metadata = await metadataResponse.json();
            
            // Fetch second file data if it exists
            const secondFile = metadata?.properties?.files?.[1];
            if (secondFile && secondFile.uri) {
              console.log(`📦 Fetching second file: ${secondFile.uri}`);
              const secondFileResponse = await fetch(secondFile.uri);
              if (secondFileResponse.ok) {
                secondFileData = await secondFileResponse.json();
              }
            }
          }
        }
        
        const chainItem = {
          mint: currentMint,
          name: nft.name,
          image: nft.json?.image || metadata.image,
          description: nft.json?.description || metadata.description,
          metadataUri: nft.uri,
          prev: metadata.prev,
          attributes: metadata.attributes || [],
          explorerLink: `https://explorer.solana.com/address/${currentMint}?cluster=devnet`,
          secondFileData: secondFileData // Include the actual second file data
        };
        
        chain.push(chainItem);
        
        // Move to the previous NFT in the chain
        currentMint = metadata.prev;
        
        // Stop if we reach null or no prev field
        if (!currentMint || currentMint === "null") {
          break;
        }
        
      } catch (error) {
        console.error(`❌ Error fetching NFT ${currentMint}:`, error.message);
        break;
      }
    }
    
    console.log(`✅ Built chain with ${chain.length} NFTs`);
    
    res.json({
      success: true,
      chain: chain.reverse(), // Reverse to show oldest first
      total: chain.length
    });
    
  } catch (err) {
    console.error("❌ Error building NFT chain:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));