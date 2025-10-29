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
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = process.env.PROGRAM_ID;

// --- App setup ---
const app = express();
// app.use(cors());
// app.use(express.json());
app.use(cors({
  origin: ['http://localhost:8080', 'http://localhost:3000'], // Frontend URLs
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Solana setup ---
const connection = new Connection(RPC_URL);
const wallet = anchor.Wallet.local();
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
anchor.setProvider(provider);
const PROGRAM_ID_PUBKEY = new anchor.web3.PublicKey(PROGRAM_ID);

// --- IDL & Program ---
const idl = JSON.parse(process.env.IDL_JSON_STRING);
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

// --- SIMPLE ENDPOINT: Get ALL tokens from wallet ---
app.get('/wallet-tokens', async (req, res) => {
  try {
    const walletAddress = wallet.publicKey.toString();
    console.log(`🔍 Fetching ALL tokens for wallet: ${walletAddress}`);
    
    // Get all NFTs owned by the wallet
    const nfts = await metaplex.nfts().findAllByOwner({ 
      owner: wallet.publicKey 
    });

    console.log(`📚 Found ${nfts.length} NFTs in wallet`);

    if (nfts.length === 0) {
      return res.json({
        success: true,
        wallet: walletAddress,
        network: 'devnet',
        tokens: [],
        message: "No NFTs found in wallet"
      });
    }

    // Process all tokens simply
    const tokens = [];

    for (const nft of nfts) {
      try {
        // Get the actual mint address
        const mintAddress = nft.mintAddress.toString();
        
        // Get creation time
        let createdAt = Date.now();
        
        if (nft.createdAt) {
          createdAt = new Date(nft.createdAt).getTime();
        } else {
          try {
            const mintKey = new PublicKey(mintAddress);
            const signatures = await connection.getSignaturesForAddress(mintKey, { limit: 1 });
            if (signatures.length > 0 && signatures[0].blockTime) {
              createdAt = signatures[0].blockTime * 1000;
            }
          } catch (error) {
            console.log(`⚠️ Could not get block time for ${mintAddress}`);
          }
        }

        // Get collection info if available
        let collectionInfo = null;
        if (nft.collection && nft.collection.address) {
          collectionInfo = {
            address: nft.collection.address.toString(),
            name: nft.collection.verified ? `Collection-${nft.collection.address.toString().slice(0, 8)}` : 'Unverified Collection'
          };
        }

        tokens.push({
          mint: mintAddress,
          name: nft.name,
          uri: nft.uri,
          createdAt: new Date(createdAt).toISOString(),
          collection: collectionInfo
        });

        console.log(`✅ Added token: ${mintAddress} - ${nft.name}`);
        
      } catch (error) {
        console.error(`💥 Error processing NFT:`, error.message);
      }
    }

    console.log(`🎉 Returning ${tokens.length} tokens`);

    res.json({
      success: true,
      wallet: walletAddress,
      network: 'devnet',
      tokens: tokens
    });

  } catch (err) {
    console.error("❌ Error fetching wallet tokens:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// --- Your existing routes below (unchanged) ---
app.get('/', (req, res) => res.send('Solana NFT Minting API running'));

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

// --- Routes ---

// --- Mock Data for Operator App ---
const mockAlerts = [
  { id: 1, type: 'warning', message: 'Mixer temperature high', time: '10:30 AM', machine: 'Mixer-01', acknowledged: false },
  { id: 2, type: 'info', message: 'Regular maintenance due', time: '09:15 AM', machine: 'Freezer-02', acknowledged: false },
  { id: 3, type: 'error', message: 'Conveyor belt speed low', time: '08:45 AM', machine: 'Conveyor-A', acknowledged: true }
];

const mockTasks = [
  { id: 1, title: 'Clean Mixer-01', description: 'Thorough cleaning of mixer unit', status: 'pending', priority: 'high' },
  { id: 2, title: 'Quality Check', description: 'Check product quality parameters', status: 'in-progress', priority: 'medium' },
  { id: 3, title: 'Stock Inventory', description: 'Count flavoring stock', status: 'pending', priority: 'low' }
];

// --- Operator App Routes ---

// Get all alerts
app.get('/api/operator/alerts', (req, res) => {
  res.json({
    success: true,
    alerts: mockAlerts
  });
});

// Acknowledge alert
app.post('/api/operator/alerts/:id/acknowledge', (req, res) => {
  const alertId = parseInt(req.params.id);
  const alert = mockAlerts.find(a => a.id === alertId);
  
  if (alert) {
    alert.acknowledged = true;
    res.json({ success: true, message: 'Alert acknowledged' });
  } else {
    res.status(404).json({ success: false, error: 'Alert not found' });
  }
});

// Get all tasks
app.get('/api/operator/tasks', (req, res) => {
  res.json({
    success: true,
    tasks: mockTasks
  });
});

// Update task status
app.put('/api/operator/tasks/:id', (req, res) => {
  const taskId = parseInt(req.params.id);
  const { status } = req.body;
  const task = mockTasks.find(t => t.id === taskId);
  
  if (task && ['pending', 'in-progress', 'completed'].includes(status)) {
    task.status = status;
    res.json({ success: true, task });
  } else {
    res.status(400).json({ success: false, error: 'Invalid status or task not found' });
  }
});

// Submit self-diagnosis
app.post('/api/operator/self-diagnosis', (req, res) => {
  const { checklist, notes } = req.body;
  
  // In a real app, you'd save this to a database
  console.log('Self-diagnosis submitted:', { checklist, notes });
  
  res.json({
    success: true,
    message: 'Self-diagnosis submitted successfully',
    timestamp: new Date().toISOString()
  });
});

// Log scan result
app.post('/api/operator/scan', (req, res) => {
  const { machineCode, scanType } = req.body;
  
  // In a real app, you'd save this to a database
  console.log('Scan recorded:', { machineCode, scanType, timestamp: new Date() });
  
  res.json({
    success: true,
    message: 'Scan recorded successfully',
    scan: {
      machineCode,
      scanType,
      timestamp: new Date().toISOString(),
      operator: 'Current Operator' // Would come from auth
    }
  });
});

// --- Manager App Routes ---

// Get production metrics
app.get('/api/manager/metrics', (req, res) => {
  const metrics = {
    dailyProduction: '2,450L',
    qualityScore: '98.7%',
    activeOperators: '8/12',
    machineEfficiency: '94.2%'
  };
  
  res.json({ success: true, metrics });
});

// Get operator status
app.get('/api/manager/operators', (req, res) => {
  const operators = [
    { id: 'OP001', name: 'John Operator', status: 'active', currentTask: 'Quality Check', efficiency: '95%' },
    { id: 'OP002', name: 'Sarah Technician', status: 'active', currentTask: 'Batch Production', efficiency: '92%' },
    { id: 'OP003', name: 'Mike Engineer', status: 'break', currentTask: 'Scheduled Break', efficiency: '88%' }
  ];
  
  res.json({ success: true, operators });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Backend is running', 
    timestamp: new Date().toISOString() 
  });
});

// Root
app.get('/', (req, res) => res.send('Solana NFT Minting API running'));

// Fetch NFT metadata
app.get('/metadata/:mint', async (req, res) => {
  try {
    console.log("🔄 Fetching all NFTs from wallet...");
    
    // Get all NFTs owned by the wallet
    const nfts = await metaplex.nfts().findAllByOwner({ 
      owner: wallet.publicKey 
    });

    console.log(`📚 Found ${nfts.length} NFTs in wallet`);

    const batches = [];

    // Process each NFT to get the second file
    for (const nft of nfts) {
      try {
        console.log(`🔍 Processing NFT: ${nft.name} (${nft.address.toString()})`);
        
        // Fetch the metadata URI
        if (!nft.uri) {
          console.log(`❌ No URI for NFT: ${nft.address.toString()}`);
          continue;
        }

        console.log(`📥 Fetching metadata from: ${nft.uri}`);
        const metadataResponse = await fetch(nft.uri);
        
        if (!metadataResponse.ok) {
          console.log(`❌ Failed to fetch metadata for: ${nft.address.toString()}`);
          continue;
        }

        const metadata = await metadataResponse.json();
        
        // Check if properties.files[1] exists
        const secondFile = metadata?.properties?.files?.[1];
        
        if (secondFile && secondFile.uri) {
          console.log(`📦 Found second file: ${secondFile.uri}`);
          
          // Fetch the second file content
          const secondFileResponse = await fetch(secondFile.uri);
          
          if (secondFileResponse.ok) {
            const secondFileData = await secondFileResponse.json();
            
            // Transform the data to match what the client expects
            const clientBatchData = {
              id: secondFileData.id || nft.address.toString(),
              name: secondFileData.name || `Batch ${batches.length + 1}`,
              status: secondFileData.status || "completed",
              startDate: secondFileData.startDate || new Date().toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
              }),
              product: secondFileData.product || nft.name || "IceCream_NFT",
              quantity: secondFileData.quantity || "500L",
              // Keep the original NFT data for reference if needed
              nft: {
                mint: nft.address.toString(),
                name: nft.name,
                metadataUri: nft.uri
              }
            };
            
            batches.push(clientBatchData);
            console.log(`✅ Successfully processed: ${nft.name}`);
          } else {
            console.log(`❌ Failed to fetch second file for: ${nft.name}`);
          }
        } else {
          console.log(`⚠️ No second file found for: ${nft.name}`);
        }
        
      } catch (error) {
        console.error(`💥 Error processing NFT ${nft.address.toString()}:`, error.message);
        // Continue with next NFT even if one fails
      }
    }

    console.log(`🎉 Successfully processed ${batches.length} batches`);

    res.json({
      success: true,
      totalNfts: nfts.length,
      processedBatches: batches.length,
      batches: batches
    });

  } catch (err) {
    console.error("❌ Error fetching recent batch:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get("/recent-batch", async (req, res) => {
  try {
    // Step 1: Fetch the first JSON from IPFS
    const firstUrl =
      "https://gateway.pinata.cloud/ipfs/bafkreib2sr2lsaqtsxsxkgpgcajxh5henxuc7v7uffo7eplnf3vvqxpwem";
    const res1 = await fetch(firstUrl);
    if (!res1.ok) throw new Error("Failed to fetch first IPFS file");
    const data1 = await res1.json();

    // Step 2: Extract the nested file URI
    const secondUri = data1?.properties?.files?.[1]?.uri;
    if (!secondUri)
      throw new Error("URI not found at properties.files[1].uri");

    // Step 3: Fetch the nested JSON
    const res2 = await fetch(secondUri);
    if (!res2.ok) throw new Error("Failed to fetch nested JSON");
    const data2 = await res2.json();

    // Step 4: Return the entire JSON
    res.json({
      success: true,
      data: data2,
    });
  } catch (err) {
    console.error("Error fetching recent batch:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
