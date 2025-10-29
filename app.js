import express from 'express';
import cors from 'cors';
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Metaplex } from '@metaplex-foundation/js';
import { createTransferInstruction, getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import 'dotenv/config';
import multer from 'multer';
import { PinataSDK } from 'pinata';
import { createHash } from 'crypto';

// --- Constants ---
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = process.env.PROGRAM_ID;

// --- App setup ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Solana setup ---
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});
const wallet = anchor.Wallet.local();
const provider = new anchor.AnchorProvider(connection, wallet, { 
  commitment: 'confirmed',
  preflightCommitment: 'confirmed'
});
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

// --- Helper function for reliable transaction sending ---
async function sendTransactionWithRetry(transaction, signers, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Transaction attempt ${attempt}/${maxRetries}`);
      
      // Get fresh blockhash for each attempt
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;

      // Sign the transaction
      if (signers.length > 0) {
        transaction.sign(...signers);
      }

      // Send raw transaction
      const rawTransaction = transaction.serialize();
      const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      console.log(`📤 Transaction sent: ${txid}`);

      // Confirm with longer timeout and commitment
      const confirmation = await connection.confirmTransaction(
        {
          signature: txid,
          blockhash: blockhash,
          lastValidBlockHeight: lastValidBlockHeight,
        },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      console.log(`✅ Transaction confirmed on attempt ${attempt}`);
      return txid;

    } catch (error) {
      lastError = error;
      console.log(`❌ Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// --- Generate unique token_id to avoid mint collisions ---
function generateUniqueTokenId(previousNftData, generation) {
  // Create a hash from previous NFT data, generation, and random component
  const dataToHash = JSON.stringify({
    previousMint: previousNftData?.mint || 'genesis',
    generation: generation,
    timestamp: Date.now(),
    random: Math.random().toString(36).substring(2, 15)
  });
  
  const hash = createHash('sha256').update(dataToHash).digest('hex');
  
  // Use first 8 characters of hash to create a unique token_id (as number)
  // This ensures the number is small enough for BN.js
  const uniqueNumber = parseInt(hash.substring(0, 8), 16);
  
  // Ensure the number is positive and within safe range
  const safeNumber = Math.abs(uniqueNumber % 1000000) + 1;
  
  console.log(`🔢 Generated token_id: ${safeNumber} from hash: ${hash.substring(0, 8)}`);
  
  return new BN(safeNumber);
}

// --- Helper function to create token account if it doesn't exist ---
async function createTokenAccountIfNeeded(connection, mint, owner, payer) {
  const tokenAccount = getAssociatedTokenAddressSync(mint, owner);
  
  try {
    // Check if token account exists
    await getAccount(connection, tokenAccount);
    console.log(`✅ Token account already exists: ${tokenAccount.toString()}`);
    return tokenAccount;
  } catch (error) {
    // Token account doesn't exist, create it
    console.log(`📝 Creating token account: ${tokenAccount.toString()}`);
    
    const createATAInstruction = createAssociatedTokenAccountInstruction(
      payer.publicKey, // payer (must be PublicKey, not Keypair)
      tokenAccount, // associated token account
      owner, // owner
      mint // mint
    );
    
    const transaction = new anchor.web3.Transaction().add(createATAInstruction);
    
    // Use the wallet's keypair directly for signing
    const txHash = await sendTransactionWithRetry(transaction, [wallet.payer]);
    console.log(`✅ Token account created: ${txHash}`);
    
    return tokenAccount;
  }
}

// --- Simplified transfer function that handles ATA creation ---
async function transferTokenToUser(mint, userPublicKey) {
  console.log("🔄 Transferring token to user...");
  
  // Get token accounts
  const sourceTokenAccount = getAssociatedTokenAddressSync(
    mint,
    wallet.publicKey
  );
  
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint,
    userPublicKey
  );

  // Check if source account exists and has tokens
  try {
    const sourceAccountInfo = await getAccount(connection, sourceTokenAccount);
    console.log(`✅ Source account balance: ${sourceAccountInfo.amount}`);
    
    if (sourceAccountInfo.amount === 0) {
      throw new Error("Source account has no tokens to transfer");
    }
  } catch (error) {
    console.log("❌ Source account issue:", error.message);
    throw new Error(`Source token account not ready: ${error.message}`);
  }

  // Check if destination account exists, create if not
  let destinationAccountExists = true;
  try {
    await getAccount(connection, destinationTokenAccount);
  } catch (error) {
    destinationAccountExists = false;
    console.log("📝 Destination token account doesn't exist, will create it");
  }

  // Create transaction with appropriate instructions
  const instructions = [];

  // Add ATA creation instruction if needed
  if (!destinationAccountExists) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, // payer
        destinationTokenAccount, // ATA address
        userPublicKey, // owner
        mint // mint
      )
    );
  }

  // Add transfer instruction
  instructions.push(
    createTransferInstruction(
      sourceTokenAccount, // from
      destinationTokenAccount, // to
      wallet.publicKey, // owner
      1 // amount (1 token)
    )
  );

  // Create and send transaction
  const transferTx = new anchor.web3.Transaction().add(...instructions);
  const transferTxHash = await sendTransactionWithRetry(transferTx, [wallet.payer]);

  console.log("✅ Token transferred to user successfully!");
  console.log("Transfer transaction:", transferTxHash);

  return transferTxHash;
}

// --- Routes ---
app.get('/', (req, res) => res.send('Solana NFT Minting API running'));

// NEW ENDPOINT: Mint and transfer token to user's wallet
app.post('/mint-token', async (req, res) => {
  let mint;
  
  try {
    const { 
      userWallet, 
      collectionMint, 
      name = "Miko Token", 
      symbol = "MIKO", 
      description = "A token from the Miko collection"
    } = req.body;

    // Validate required fields
    if (!userWallet) {
      return res.status(400).json({ success: false, error: "User wallet address is required" });
    }

    if (!collectionMint) {
      return res.status(400).json({ success: false, error: "Collection mint address is required" });
    }

    console.log("🎯 Starting token mint for user:", userWallet);
    console.log("📦 Collection:", collectionMint);

    // Get collection info to determine next generation
    let nextGeneration = 1;
    let previousMint = collectionMint;
    let previousNftData = { mint: collectionMint };

    try {
      // Fetch the current collection chain to determine the next generation
      const chainResponse = await fetch(`http://localhost:${PORT}/nft-chain?mint=${collectionMint}`);
      if (chainResponse.ok) {
        const chainData = await chainResponse.json();
        if (chainData.success && chainData.chain.length > 0) {
          nextGeneration = chainData.chain.length + 1;
          previousMint = chainData.chain[chainData.chain.length - 1].mint;
          previousNftData = chainData.chain[chainData.chain.length - 1];
          console.log(`📊 Next generation: ${nextGeneration}, Previous mint: ${previousMint}`);
        }
      }
    } catch (error) {
      console.log("⚠️ Could not fetch chain data, using default generation");
    }

    // Generate token-specific data
    const tokenName = `${name} #${nextGeneration}`;
    const tokenDescription = `${description} - Generation ${nextGeneration}`;
    const collection_id = "MK_43";

    console.log("📤 Step 1: Creating metadata for token...");

    // 1. Create metadata JSON
    const metadataJson = {
      name: tokenName,
      symbol,
      description: tokenDescription,
      seller_fee_basis_points: 500,
      image: "https://gateway.pinata.cloud/ipfs/QmYourDefaultImageCID",
      attributes: [
        { trait_type: "Generation", value: nextGeneration.toString() },
        { trait_type: "Collection", value: "Miko Timeline" },
        { trait_type: "Type", value: "Evolution Token" }
      ],
      properties: {
        category: "image",
        files: [
          { 
            uri: "https://gateway.pinata.cloud/ipfs/QmYourDefaultImageCID", 
            type: "image/png" 
          }
        ],
        creators: [
          { 
            address: wallet.publicKey.toString(), 
            verified: true, 
            share: 100 
          }
        ]
      },
      prev: previousMint,
      generation: nextGeneration,
      collection: collectionMint,
      createdAt: new Date().toISOString()
    };

    // 2. Upload metadata JSON to Pinata
    console.log("📝 Step 2: Uploading metadata JSON to Pinata...");
    const jsonUpload = await pinata.upload.public.json(metadataJson, { 
      name: `miko-token-${nextGeneration}.json` 
    });
    const metadataUri = `https://gateway.pinata.cloud/ipfs/${jsonUpload.cid}`;
    
    console.log("✅ Metadata uploaded to Pinata:", metadataUri);

    // 3. Generate UNIQUE token_id to avoid PDA collisions
    console.log("🎨 Step 3: Generating unique token_id...");
    
    const uniqueTokenId = generateUniqueTokenId(previousNftData, nextGeneration);

    // 4. Use PDA for mint (as expected by the program)
    [mint] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_SEED), Buffer.from(collection_id), toNumberBuffer(uniqueTokenId)],
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

    // Create destination token account for the SERVER (not user)
    const serverDestination = await anchor.utils.token.associatedAddress({
      mint,
      owner: wallet.publicKey,
    });

    // Check if mint already exists
    try {
      const info = await connection.getAccountInfo(mint);
      if (info) {
        console.log("⚠️ Mint PDA already exists, generating new token_id...");
        // Generate a new token_id if PDA already exists
        const uniqueTokenId = generateUniqueTokenId(previousNftData, nextGeneration + 1000);
        [mint] = PublicKey.findProgramAddressSync(
          [Buffer.from(MINT_SEED), Buffer.from(collection_id), toNumberBuffer(uniqueTokenId)],
          program.programId
        );
        console.log(`🔄 Using alternative token_id: ${uniqueTokenId.toString()}`);
      }
    } catch (error) {
      // Mint doesn't exist, which is what we want
      console.log("✅ Mint PDA is available");
    }

    console.log("  Using mint PDA:", mint.toString());

    // Context for minting - using SERVER's wallet for destination
    const context = {
      mint: mint,
      payer: wallet.publicKey,
      destination: serverDestination,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      metadata: metadataAddress,
      masterEdition: masterEditionAddress,
      collection: new PublicKey(collectionMint),
    };

    console.log("📝 Accounts setup complete, sending mint transaction...");

    // Build and send mint transaction - ONLY wallet.payer as signer (not mint keypair)
    const mintTx = await program.methods
      .createCollection(
        { 
          name: tokenName, 
          symbol, 
          uri: metadataUri,
          sellerFeeBasisPoints: 500 
        }, 
        collection_id,
        uniqueTokenId
      )
      .accounts(context)
      .transaction();

    // Only sign with wallet.payer - the PDA is created by the program
    const mintTxHash = await sendTransactionWithRetry(mintTx, [wallet.payer]);

    console.log("✅ Token minted to server wallet successfully!");
    console.log("Mint transaction:", mintTxHash);
    console.log("Mint address:", mint.toString());

    // Wait a moment for the mint to be fully processed
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 4. Transfer token from SERVER to USER using simplified function
    const userPublicKey = new PublicKey(userWallet);
    const transferTxHash = await transferTokenToUser(mint, userPublicKey);

    // Verify the token was transferred to the user
    try {
      const destinationTokenAccount = getAssociatedTokenAddressSync(mint, userPublicKey);
      const tokenAccount = await getAccount(connection, destinationTokenAccount);
      console.log("✅ Token balance verified in user's wallet:", tokenAccount.amount.toString());
    } catch (error) {
      console.log("⚠️ Could not verify token balance:", error.message);
    }

    // 5. Return all results with explorer links
    const explorerBaseUrl = 'https://explorer.solana.com';
    const mintAddress = mint.toString();

    const response = {
      success: true,
      message: "Token minted and transferred to user wallet successfully",
      token: {
        mint: mintAddress,
        name: tokenName,
        description: tokenDescription,
        generation: nextGeneration,
        tokenId: uniqueTokenId.toString(),
        metadataUrl: metadataUri,
        imageUrl: metadataJson.image
      },
      transactions: {
        mint: mintTxHash,
        transfer: transferTxHash
      },
      transfer: {
        from: wallet.publicKey.toString(),
        to: userWallet,
        confirmed: true
      },
      explorerLink: `${explorerBaseUrl}/address/${mintAddress}?cluster=devnet`,
      mintTransactionLink: `${explorerBaseUrl}/tx/${mintTxHash}?cluster=devnet`,
      transferTransactionLink: `${explorerBaseUrl}/tx/${transferTxHash}?cluster=devnet`,
      collection: {
        address: collectionMint,
        totalGenerations: nextGeneration
      }
    };

    res.json(response);

  } catch (err) {
    console.error("❌ Token minting failed:", err);
    
    // If we have the mint address but something failed, we might want to clean up
    if (mint) {
      console.log(`⚠️ Mint was created but transfer failed: ${mint.toString()}`);
    }
    
    res.status(500).json({ 
      success: false,
      error: "Token minting failed", 
      details: err.message 
    });
  }
});

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

    // 4. Generate unique token_id for this NFT
    console.log("🎨 Step 3: Generating unique token_id...");
    
    const previousNftData = { mint: prev || 'genesis' };
    const uniqueTokenId = generateUniqueTokenId(previousNftData, 1);
    
    // Use PDA for mint (as expected by the program)
    const [mint] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_SEED), Buffer.from(collection_id), toNumberBuffer(uniqueTokenId)],
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

    // Check if mint already exists (just for logging)
    try {
      const info = await connection.getAccountInfo(mint);
      if (info) {
        console.log("⚠️ Mint PDA already exists, generating new token_id...");
        const uniqueTokenId = generateUniqueTokenId(previousNftData, 2);
        [mint] = PublicKey.findProgramAddressSync(
          [Buffer.from(MINT_SEED), Buffer.from(collection_id), toNumberBuffer(uniqueTokenId)],
          program.programId
        );
      }
    } catch (error) {
      console.log("✅ Mint PDA is available");
    }

    console.log("  Using mint PDA:", mint.toString());

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

    // Only sign with wallet.payer - the PDA is created by the program
    const txHash = await sendTransactionWithRetry(tx, [wallet.payer]);

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

// ... rest of your existing endpoints remain the same ...

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

app.post("/mint-collection", upload.fields([
  { name: "image", maxCount: 1 },
  { name: "extraFile", maxCount: 1 }
]), async (req, res) => {
  try {
    const { name = "IceCream_NFT", symbol = "UNLVR", description = "", collection_id = "MK_00", prev = "null", collectionAddress="", token_id=1 } = req.body;
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

    // 4. Generate unique token_id for this collection item
    console.log("🎨 Step 3: Generating unique token_id...");
    
    const previousNftData = { mint: prev || 'genesis' };
    const uniqueTokenId = generateUniqueTokenId(previousNftData, token_id);
    
    // Use PDA for mint (as expected by the program)
    const [mint] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_SEED), Buffer.from(collection_id), toNumberBuffer(uniqueTokenId)],
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

    // Check if mint already exists (just for logging)
    try {
      const info = await connection.getAccountInfo(mint);
      if (info) {
        console.log("⚠️ Mint PDA already exists, generating new token_id...");
        const uniqueTokenId = generateUniqueTokenId(previousNftData, token_id + 1000);
        [mint] = PublicKey.findProgramAddressSync(
          [Buffer.from(MINT_SEED), Buffer.from(collection_id), toNumberBuffer(uniqueTokenId)],
          program.programId
        );
      }
    } catch (error) {
      console.log("✅ Mint PDA is available");
    }

    console.log("  Using mint PDA:", mint.toString());

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
      collection: new anchor.web3.PublicKey(collectionAddress),
    };

    console.log("📝 Accounts setup complete, sending transaction...");

    // Transaction matching your test EXACTLY
    const tx = await program.methods
      .createCollection(
        { 
          name, 
          symbol, 
          uri: metadataUri,
          sellerFeeBasisPoints: 500 
        }, 
        collection_id,
        uniqueTokenId
      )
      .accounts(context)
      .transaction();

    // Only sign with wallet.payer - the PDA is created by the program
    const txHash = await sendTransactionWithRetry(tx, [wallet.payer]);

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

app.get('/server-collections-latest', async (req, res) => {
  try {
    const walletAddress = wallet.publicKey.toString();
    console.log(`🔍 Fetching collections for server wallet: ${walletAddress} on devnet`);

    return await fetchCollectionsWithMetaplex(walletAddress, res);

  } catch (err) {
    console.error("❌ Error fetching server wallet collections:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// --- Helper function: Fetch with Metaplex (Devnet compatible) ---
async function fetchCollectionsWithMetaplex(walletAddress, res) {
  try {
    const owner = new PublicKey(walletAddress);
    
    console.log("🔍 Using Metaplex to fetch NFTs from devnet...");
    
    // Get all NFTs owned by wallet
    const nfts = await metaplex.nfts().findAllByOwner({ owner });
    console.log(`📚 Found ${nfts.length} NFTs in server wallet`);

    if (nfts.length === 0) {
      return res.json({
        success: true,
        wallet: walletAddress,
        network: 'devnet',
        totalCollections: 0,
        collections: [],
        message: "No NFTs found in server wallet on devnet"
      });
    }

    // Group by collection
    const collectionsMap = new Map();

    for (const nft of nfts) {
      try {
        // On devnet, we might have unverified collections, so we check both
        const collectionAddress = nft.collection?.address?.toString();
        
        if (collectionAddress) {
          if (!collectionsMap.has(collectionAddress)) {
            collectionsMap.set(collectionAddress, {
              collectionAddress,
              collectionName: nft.collection?.address.toString() || `Collection-${collectionAddress.slice(0, 8)}`,
              tokens: []
            });
          }
          
          const collection = collectionsMap.get(collectionAddress);
          
          // Try to get creation time from metadata or use current time
          let createdAt = new Date();
          if (nft.uri) {
            try {
              const metadataResponse = await fetch(nft.uri);
              if (metadataResponse.ok) {
                const metadata = await metadataResponse.json();
                if (metadata.createdAt) {
                  createdAt = new Date(metadata.createdAt);
                } else if (nft.createdAt) {
                  createdAt = new Date(nft.createdAt);
                }
              }
            } catch (e) {
              // If we can't fetch metadata, use current time
              console.log(`⚠️ Could not fetch metadata for ${nft.address.toString()}`);
            }
          }
          
          collection.tokens.push({
            mint: nft.address.toString(),
            name: nft.name || 'Unknown NFT',
            image: nft.json?.image || null,
            description: nft.json?.description || '',
            createdAt,
            nftData: nft
          });
        } else {
          // Handle NFTs without collections by putting them in an "Ungrouped" collection
          const ungroupedKey = 'ungrouped';
          if (!collectionsMap.has(ungroupedKey)) {
            collectionsMap.set(ungroupedKey, {
              collectionAddress: ungroupedKey,
              collectionName: 'Ungrouped NFTs',
              tokens: []
            });
          }
          
          const ungroupedCollection = collectionsMap.get(ungroupedKey);
          let createdAt = new Date();
          
          if (nft.uri) {
            try {
              const metadataResponse = await fetch(nft.uri);
              if (metadataResponse.ok) {
                const metadata = await metadataResponse.json();
                if (metadata.createdAt) {
                  createdAt = new Date(metadata.createdAt);
                } else if (nft.createdAt) {
                  createdAt = new Date(nft.createdAt);
                }
              }
            } catch (e) {
              console.log(`⚠️ Could not fetch metadata for ${nft.address.toString()}`);
            }
          }
          
          ungroupedCollection.tokens.push({
            mint: nft.address.toString(),
            name: nft.name || 'Unknown NFT',
            image: nft.json?.image || null,
            description: nft.json?.description || '',
            createdAt,
            nftData: nft
          });
        }
      } catch (error) {
        console.error(`💥 Error processing NFT ${nft.address?.toString()}:`, error.message);
      }
    }

    // Find latest token for each collection
    const collectionsWithLatestTokens = Array.from(collectionsMap.values()).map(collection => {
      const sortedTokens = collection.tokens.sort((a, b) => b.createdAt - a.createdAt);
      const latestToken = sortedTokens[0];
      
      return {
        collection: {
          address: collection.collectionAddress,
          name: collection.collectionName,
          verified: collection.collectionAddress !== 'ungrouped', // Ungrouped are not verified
          totalTokens: collection.tokens.length
        },
        latestToken: {
          mint: latestToken.mint,
          name: latestToken.name,
          image: latestToken.image,
          description: latestToken.description,
          createdAt: latestToken.createdAt.toISOString()
        },
        allTokens: collection.tokens.slice(0, 3).map(token => ({
          mint: token.mint,
          name: token.name,
          image: token.image
        }))
      };
    });

    console.log(`🎯 Found ${collectionsWithLatestTokens.length} collections with latest tokens`);

    res.json({
      success: true,
      wallet: walletAddress,
      network: 'devnet',
      totalCollections: collectionsWithLatestTokens.length,
      totalNfts: nfts.length,
      collections: collectionsWithLatestTokens,
      source: 'metaplex'
    });

  } catch (err) {
    console.error("❌ Error with Metaplex:", err);
    throw err;
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));