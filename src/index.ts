// =======================
// Imports and Setup
// =======================
import type { TextBlock } from '@anthropic-ai/sdk/resources';
import Anthropic from '@anthropic-ai/sdk';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { methodOverride } from 'hono/method-override';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { Agent } from "agents";
import { createWorkersAI } from 'workers-ai-provider';

// =======================
// Agent for Background Processing
// =======================
export class MyAgent extends Agent {
  async run(event: WorkflowEvent<any>, step: WorkflowStep) {
    if (event.name === "reindex-doc") {
      const { filename, uploader } = event.payload;
      const fileObj = await this.env.R2.get(filename);
      if (!fileObj) {
        console.error("File not found in R2 for reindexing:", filename);
        return;
      }
      // Create a File-like object for processDocument
      const file = new File([await fileObj.arrayBuffer()], filename, { type: fileObj.httpMetadata?.contentType || "application/octet-stream" });
      await processDocument(file, this.env, uploader);
    }
  }
}

// =======================
// End Imports and Setup
// =======================

// =======================
// App Initialization
// =======================
// Create a new Hono app and enable CORS middleware.
const app = new Hono<{ Bindings: Env }>();
app.use(cors());
// =======================
// End App Initialization
// =======================

// =======================
// HTML Template
// =======================
// This function returns the HTML for the chatbot UI, including modals and forms.
const html = (question = '', successMessage = '', notes: QA_Pair[] = []) => `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>Chat | murry-ai</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
    <style>
      .btn {
        transition: all 0.3s ease;
        padding: 10px 20px;
        margin: 5px;
        cursor: pointer;
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      }
      .btn:active {
        transform: translateY(0);
        box-shadow: none;
      }
      #add-question-modal, #upload-modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        display: none;
        justify-content: center;
        align-items: center;
        transition: all 0.3s ease;
      }
      #add-question-modal.show, #upload-modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: white;
        padding: 20px;
        border-radius: 8px;
        max-width: 80%;
        width: 90%;
        position: relative;
        z-index: 1;
      }
      #upload-modal .modal-content {
        position: relative;
        max-width: 60%;
        width: 80%;
      }
      #upload-modal .modal-content button[aria-label="Close"] {
        position: absolute;
        top: 10px;
        right: 10px;
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: #888;
        transition: color 0.3s ease;
      }
      #upload-modal .modal-content button[aria-label="Close"]:hover {
        color: #333;
      }
      /* Updated CSS for green success message */
      .success-message {
        background-color: #d4edda !important;
        border: 1px solid #c3e6cb !important;
        color: #155724 !important;
        padding: 10px;
        border-radius: 5px;
        margin: 10px 0;
      }
      /* Updated CSS for spinner animation */
      .loading {
        display: inline-block;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
    <script src="https://unpkg.com/htmx.org/dist/htmx.js"></script>
  </head>
  <body>
    <h1>murry-ai</h1>
    <p>By <a href="https://lawrencemurry.com" target="_blank">Lawrence Murry, CF APMP, PSM I</a></p>
    <p>
      <small>
        <button class="btn btn-default" id="add-question-button">
          <a href="/write" style="color: black; text-decoration: none;">
            <i class="fa fa-plus"></i> Add to Content Library
          </a>
        </button>
        <button class="btn btn-default" id="upload-button">
          <i class="fa fa-upload"></i> Upload
        </button>
      </small>
    </p>
    
    <!-- Chat form -->
    <form hx-post="/" hx-trigger="submit" hx-target="#result" hx-swap="innerHTML" hx-headers='{"Content-Type": "application/json"}'>
      <textarea name="question" required placeholder="Ask the AI anything">${question}</textarea>
      <button type="submit" class="btn btn-primary">
        Submit <span class="loading" style="display: none;">🔄</span>
      </button>
    </form>
    <p id="result"></p>
    
    <!-- Q&A Modal -->
    <div id="add-question-modal" class="modal">
      <div class="modal-content">
        <h2>Add to Content Library</h2>
        <form id="add-question-form">
          <label for="question">Question:</label>
          <textarea id="question" name="question" required></textarea>
          <label for="answer">Answer:</label>
          <textarea id="answer" name="answer" required></textarea>
          <button type="submit" class="btn btn-primary">
            Submit <span class="loading" style="display: none;">🔄</span>
          </button>
        </form>
      </div>
    </div>
    
    <!-- Upload Modal -->
    <div id="upload-modal" class="modal">
      <div class="modal-content">
        <h2>Upload Document</h2>
        <form id="upload-form" enctype="multipart/form-data">
          <input type="file" id="file" name="file" required />
          <button type="submit" class="btn btn-primary">
            Upload <span class="loading" style="display: none;">🔄</span>
          </button>
        </form>
      </div>
    </div>
    
    <script type="module">
      document.addEventListener("DOMContentLoaded", () => {
        // Q&A Modal element references
        const addQuestionButton = document.getElementById("add-question-button");
        const addQuestionModal = document.getElementById("add-question-modal");
        const addQuestionForm = document.getElementById("add-question-form");
        
        // Upload Modal element references
        const uploadButton = document.getElementById("upload-button");
        const uploadModal = document.getElementById("upload-modal");
        const uploadModalContent = uploadModal.querySelector('.modal-content');
        const uploadForm = document.getElementById("upload-form");
        const fileInput = document.getElementById("file");
        
        // Open Q&A modal
        addQuestionButton.addEventListener("click", (e) => {
          e.preventDefault();
          document.getElementById("question").value = "";
          document.getElementById("answer").value = "";
          addQuestionModal.classList.add("show");
        });
        
        // Close modal when clicking outside
        window.addEventListener("click", (e) => {
          if (e.target === addQuestionModal) {
            addQuestionModal.classList.remove("show");
          }
          if (e.target === uploadModal) {
            uploadModal.classList.remove("show");
          }
        });
        
        // Add active state on buttons
        document.querySelectorAll('.btn').forEach(button => {
          button.addEventListener('click', () => {
            button.classList.add('active');
            setTimeout(() => {
              button.classList.remove('active');
            }, 200);
          });
        });
        
        // Q&A form submission for saving question-answer pairs
        addQuestionForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const submitButton = e.target.querySelector('button[type="submit"]');
          const loadingSpinner = submitButton.querySelector('.loading');
          loadingSpinner.style.display = 'inline-block';
          
          const question = document.getElementById("question").value.trim();
          const answer = document.getElementById("answer").value.trim();
          
          try {
            const response = await fetch("/questions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ question, answer })
            });
            
            if (response.ok) {
              const result = await response.json();
              addQuestionModal.classList.remove("show");
              const successMessageElement = document.createElement("p");
              successMessageElement.className = "success-message";
              successMessageElement.textContent = result.message;
              document.body.appendChild(successMessageElement);
              setTimeout(() => {
                successMessageElement.remove();
              }, 5000);
            } else {
              alert("Failed to create question and answer");
            }
          } catch (error) {
            console.error("Error:", error);
            alert("An error occurred while saving the question and answer");
          } finally {
            loadingSpinner.style.display = "none";
          }
        });
        
        // Chat form submission (already using htmx)
        document.querySelector('form[hx-post="/"]').addEventListener("submit", function (e) {
          e.preventDefault();
          const submitButton = this.querySelector('button[type="submit"]');
          const loadingSpinner = submitButton.querySelector('.loading');
          loadingSpinner.style.display = "inline-block";
          
          const question = this.querySelector('textarea[name="question"]').value.trim();
          fetch("/", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ question })
          })
            .then(response => response.text())
            .then(result => {
              document.getElementById("result").innerHTML = result;
            })
            .catch(error => {
              console.error("Error:", error);
              alert("An error occurred while processing your request.");
            })
            .finally(() => {
              loadingSpinner.style.display = "none";
            });
        });
        
        // Open Upload modal
        uploadButton.addEventListener("click", () => {
          uploadModal.classList.add("show");
        });
        uploadModal.addEventListener("click", (e) => {
          if (e.target === uploadModal) {
            uploadModal.classList.remove("show");
          }
        });
        uploadModalContent.addEventListener("click", (e) => {
          e.stopPropagation();
        });
        
        // Create a close button for the Upload modal
        const closeButton = document.createElement("button");
        closeButton.innerHTML = "&times;";
        closeButton.style.position = "absolute";
        closeButton.style.top = "10px";
        closeButton.style.right = "10px";
        closeButton.style.background = "none";
        closeButton.style.border = "none";
        closeButton.style.fontSize = "24px";
        closeButton.style.cursor = "pointer";
        closeButton.setAttribute("aria-label", "Close");
        closeButton.addEventListener("click", () => {
          uploadModal.classList.remove("show");
        });
        uploadModalContent.insertBefore(closeButton, uploadModalContent.firstChild);
        
        // Upload form submission
        uploadForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const submitButton = e.target.querySelector("button[type='submit']");
          const loadingSpinner = submitButton.querySelector(".loading");
          loadingSpinner.style.display = "inline-block";
          const formData = new FormData();
          formData.append("file", fileInput.files[0]);
          
          try {
            const response = await fetch("/upload", {
              method: "POST",
              body: formData
            });
            
            if (response.ok) {
              alert("File uploaded successfully");
              uploadModal.classList.remove("show");
              fileInput.value = "";
            } else {
              const errorData = await response.json();
              alert(errorData.message || "Failed to upload file");
            }
          } catch (error) {
            console.error("Error:", error);
            alert("An error occurred while uploading the file");
          } finally {
            loadingSpinner.style.display = "none";
          }
        });
      });
    </script>
  </body>
</html>
`;
// =======================
// End HTML Template
// =======================

// =======================
// File Upload Config
// =======================
// Allowed file types, maximum file size, and upload auth key
const ALLOWED_FILE_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/pdf'
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const UPLOAD_AUTH_KEY = 'your-secure-upload-key';
// =======================
// End File Upload Config
// =======================

// =======================
// File Text Extraction
// =======================
// Utility function to extract text from various file types (PDF parsing added)
async function extractTextFromFile(file: File): Promise<string> {
  const fileType = file.type;
  const arrayBuffer = await file.arrayBuffer();
  if (fileType === 'application/pdf') {
    return "PDF parsing is not supported in this environment.";
  } else if (
    fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileType === 'application/msword'
  ) {
    try {
      const { value } = await mammoth.convertToHtml({ arrayBuffer });
      return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return "Failed to extract text from Word document.";
    }
  } else if (
    fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    fileType === 'application/vnd.ms-excel'
  ) {
    try {
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      let text = "";
      workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        text += csv + "\n";
      });
      return text;
    } catch (e) {
      return "Failed to extract text from Excel document.";
    }
  } else if (fileType === 'text/csv') {
    const csvText = new TextDecoder().decode(new Uint8Array(arrayBuffer));
    return csvText.split("\n")
      .map(row => row.split(",").map(cell => cell.trim()).join(" "))
      .join("\n");
  } else if (
    fileType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileType === 'application/vnd.ms-powerpoint'
  ) {
    return "PPT and PPTX parsing is not supported in this environment.";
  } else {
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
}
// =======================
// End File Text Extraction
// =======================

// =======================
// Document Processing
// =======================
// Process document: extract text, split into chunks, and store embeddings
async function processDocument(file: File, env: Env, uploader: string = "anonymous"): Promise<number> {
  const now = new Date().toISOString();
  const fullText = await extractTextFromFile(file);
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 200,
    chunkOverlap: 50,
  });
  const documents = await splitter.createDocuments([fullText]);
  const chunks = documents.map(doc => doc.pageContent);

  let totalInserted = 0;
  for (const [index, chunk] of chunks.entries()) {
    const aiResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: chunk });
    const embedding = aiResponse.data[0];
    if (!embedding) continue;
    const vectorId = `doc-${Date.now()}-${index}`;
    await env.VECTOR_INDEX.upsert([
      {
        id: vectorId,
        values: embedding,
        metadata: {
          text: chunk,
          docId: file.name,
          chunkId: vectorId,
          chunkPreview: chunk.slice(0, 80),
          filename: file.name,
          uploaded_at: now,
          uploader
        }
      }
    ]);
    totalInserted++;
  }
  return totalInserted;
}
// =======================
// End Document Processing
// =======================

// =======================
// Routes
// =======================

// GET "/" - main chatbot page
app.get("/", async (c) => {
  const { results: notes } = await c.env.DATABASE.prepare("SELECT * FROM questions ORDER BY id DESC").all<QA_Pair>();
  return c.html(html("", "", notes));
});

// GET "/write" - also return chatbot page (e.g., for new Q&A entry)
app.get("/write", async (c) => {
  return c.html(html());
});

// POST "/questions" - Save question and answer pairs to D1
app.post("/questions", async (c) => {
  let body: { question: string; answer: string };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ success: false, message: "Invalid JSON payload" }, 400);
  }
  const { question, answer } = body;
  if (!question || !answer || typeof question !== "string" || typeof answer !== "string") {
    return c.json({ success: false, message: "Missing or invalid fields" }, 400);
  }
  const sanitizedQuestion = question.trim();
  const sanitizedAnswer = answer.trim();

  try {
    // Deduplication: Vector similarity check
    const embeddingResult = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: sanitizedQuestion });
    const embedding = embeddingResult.data?.[0];
    if (!embedding || embedding.length === 0) {
      return c.json({ success: false, message: 'Failed to generate embedding' }, 400);
    }
    // Query for similar questions (top 3)
    const vectorResult = await c.env.VECTOR_INDEX.query([embedding], { topK: 3 });
    const vectorSearchMatches = vectorResult.matches || [];
    // Confidence-based fallback
    const bestMatch = vectorSearchMatches[0];
    if (bestMatch?.score < 0.75) {
      return c.html(`<p>I’m not confident I can answer that accurately based on the available information. Please upload more related documents or rephrase your question.</p>`);
    }

    // Traditional deduplication
    const checkQuery = "SELECT * FROM questions WHERE question = ? AND answer = ? LIMIT 1";
    const { results: existing } = await c.env.DATABASE.prepare(checkQuery)
      .bind(sanitizedQuestion, sanitizedAnswer)
      .all() as { results: QA_Pair[] };
    if (existing.length > 0) {
      return c.json({ success: false, message: "A similar question and answer pair is already stored in the database." }, 409);
    }

    // Insert with metadata
    const now = new Date().toISOString();
    const uploader = c.req.header("X-User") || "anonymous";
    const query = "INSERT INTO questions (question, answer, created_at, uploader) VALUES (?, ?, ?, ?) RETURNING id";
    const { results } = await c.env.DATABASE.prepare(query)
      .bind(sanitizedQuestion, sanitizedAnswer, now, uploader)
      .run() as { results: { id: string }[] };
    const recordId = results[0].id as string;

    await c.env.VECTOR_INDEX.insert([
      {
        id: recordId.toString(),
        values: embedding,
        metadata: {
          text: `Q: ${sanitizedQuestion}\nA: ${sanitizedAnswer}`,
          question: sanitizedQuestion,
          answer: sanitizedAnswer,
          created_at: now,
          uploader
        }
      }
    ]);
    return c.json({ success: true, message: "Question and answer saved successfully!" }, 201);
  } catch (error) {
    return c.json({ success: false, message: "An error occurred while saving the question and answer" }, 500);
  }
});

// POST "/" - Main chat endpoint with confidence fallback, citation, and strict prompt
app.post("/", async (c) => {
  let body: { question: string };
  const contentType = c.req.header("Content-Type") || "";
  try {
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await c.req.parseBody();
      body = { question: typeof formData.question === "string" ? formData.question : "" };
    } else {
      return c.text("Unsupported Content-Type", 400);
    }
  } catch (err) {
    return c.text("Invalid payload", 400);
  }
  if (!body.question || typeof body.question !== "string") {
    return c.text("Missing or invalid 'question' field", 400);
  }

  // Vector search and citation logic
  let citationInfo: string | null = null;
  let vectorSearchMatches: any[] = [];
  let contextChunks: string[] = [];
  let bestMatch: any = null;

  if (c.env.VECTOR_INDEX && body.question) {
    try {
      const embeddingResult = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: body.question });
      const embedding = embeddingResult.data?.[0];
      if (!embedding || embedding.length === 0) {
        return c.json({ success: false, message: 'Failed to generate embedding' }, 400);
      }
      const vectorResult = await c.env.VECTOR_INDEX.query([embedding], { topK: 3 });
      vectorSearchMatches = vectorResult.matches || [];
      bestMatch = vectorSearchMatches[0];
      // Confidence-based fallback
      if (!bestMatch || bestMatch.score < 0.75) {
        return c.html(`<p>I’m not confident I can answer that accurately based on the available information. Please upload more related documents or rephrase your question.</p>`);
      }
      // Build context from top matches
      for (const match of vectorSearchMatches) {
        if (match.metadata && match.metadata.text) {
          contextChunks.push(match.metadata.text);
        } else if (match.text) {
          contextChunks.push(match.text);
        }
      }
      // Enhanced citation
      const meta = bestMatch?.metadata || {};
      citationInfo = meta.filename
        ? `<p>Based on document: <b>${meta.filename}</b>, section: <i>${meta.chunkPreview || ''}</i></p>`
        : `<p>Based on document chunk: <b>${bestMatch?.id}</b></p>`;
    } catch (error) {
      return c.json({ success: false, message: 'Failed to process vector search' }, 500);
    }
  }

  // Strict system prompt
  let systemPrompt = `
You are a Cloudflare RFP assistant. You must only respond using provided notes or document context.
If context is insufficient or ambiguous, reply: "I'm not sure based on the current information."
Avoid fabricating any information.
`;

  // Notes context as separate user message
  const { results: notes } = await c.env.DATABASE
    .prepare("SELECT * FROM questions WHERE question LIKE ? ORDER BY id DESC LIMIT 3")
    .bind(`%${body.question}%`)
    .all<QA_Pair>();
  let notesContext = "";
  if (notes.length > 0) {
    notesContext = notes.map(n => `Q: ${n.question}\nA: ${n.answer}`).join("\n---\n");
  }
  let vectorContext = contextChunks.join("\n---\n");

  // Compose messages array for LLM
  const messages = [
    { role: "system", content: systemPrompt },
    ...(notesContext ? [{ role: "user", content: "Reference notes:\n" + notesContext }] : []),
    ...(vectorContext ? [{ role: "user", content: "Relevant document context:\n" + vectorContext }] : []),
    { role: "user", content: body.question }
  ];

  // AI API Key Check
  if (!c.env.ANTHROPIC_API_KEY && !c.env.AI) {
    return c.text("AI service is not configured. Please check your API keys.", 500);
  }

  try {
    let modelUsed: string = "";
    let model = "@cf/meta/llama-4-scout-17b-16e-instruct";
    let aiStream: ReadableStream | null = null;

    if (c.env.ANTHROPIC_API_KEY) {
      const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
      modelUsed = "claude-3-5-sonnet-latest";
      const stream = await anthropic.messages.stream({
        max_tokens: 4096,
        model: modelUsed,
        messages,
      });
      const encoder = new TextEncoder();
      const wrapperStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`<div id="streamed-response" style="white-space:pre-line;">`));
          (async () => {
            for await (const message of stream) {
              if (message.type === "content_block_delta" && 'text' in (message.delta || {})) {
                let cleaned = message.delta.text
                  .replace(/^\*+|\*+$/gm, '')
                  .replace(/\n{2,}/g, '<br><br>')
                  .replace(/\n/g, '<br>');
                controller.enqueue(encoder.encode(cleaned));
              }
            }
            let confidence = Math.round((bestMatch?.score ?? 0) * 100);
            controller.enqueue(encoder.encode(`</div>
              <p class="result-confidence" style="background:#e7f5e6;color:#155724;padding:6px 12px;border-radius:4px;margin:10px 0 0 0;font-size:0.97em;">
                Confidence: ${confidence}% | Source: ${bestMatch?.metadata?.filename || bestMatch?.id}
              </p>
              ${citationInfo ? `<div style="margin-top:10px;font-size:0.95em;color:#666;">${citationInfo}</div>` : ""}
              <button onclick="copyResponseText()" title="Copy" style="background:none;border:none;cursor:pointer;margin-top:10px;">
                <i class="fa fa-copy"></i>
              </button>
              <script>
                function copyResponseText() {
                  const el = document.getElementById('streamed-response');
                  if (!el) return;
                  const temp = document.createElement('textarea');
                  temp.value = el.innerText || el.textContent;
                  document.body.appendChild(temp);
                  temp.select();
                  document.execCommand('copy');
                  document.body.removeChild(temp);
                }
              </script>
            `));
            controller.close();
          })();
        }
      });
      return new Response(wrapperStream, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    } else {
      aiStream = await c.env.AI.run(
        model,
        {
          messages,
          max_tokens: 4096,
          stream: true
        }
      );
      if (aiStream) {
        const encoder = new TextEncoder();
        const wrapperStream = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(`<div id="streamed-response" style="white-space:pre-line;">`));
            const reader = aiStream.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += value;
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice('data: '.length).trim();
                  if (data === '[DONE]') continue;
                  try {
                    const jsonData = JSON.parse(data);
                    if (jsonData.response) {
                      let cleaned = jsonData.response
                        .replace(/^\*+|\*+$/gm, '')
                        .replace(/\n{2,}/g, '<br><br>')
                        .replace(/\n/g, '<br>');
                      controller.enqueue(encoder.encode(cleaned));
                    }
                  } catch (e) {}
                }
              }
            }
            let confidence = Math.round((bestMatch?.score ?? 0) * 100);
            controller.enqueue(encoder.encode(`</div>
              <p class="result-confidence" style="background:#e7f5e6;color:#155724;padding:6px 12px;border-radius:4px;margin:10px 0 0 0;font-size:0.97em;">
                Confidence: ${confidence}% | Source: ${bestMatch?.metadata?.filename || bestMatch?.id}
              </p>
              ${citationInfo ? `<div style="margin-top:10px;font-size:0.95em;color:#666;">${citationInfo}</div>` : ""}
              <i onclick="copyResponseText()" title="Copy" style="background:none;border:none;cursor:pointer;margin-top:10px;" class="fa fa-copy"></i>
              <span id="copy-message" style="display:none;margin-left:8px;color:green;font-size:0.9em;">Copied!</span>
              <script>
                function copyResponseText() {
                  const el = document.getElementById('streamed-response');
                  if (!el) return;
                  const temp = document.createElement('textarea');
                  temp.value = el.innerText || el.textContent;
                  document.body.appendChild(temp);
                  temp.select();
                  document.execCommand('copy');
                  document.body.removeChild(temp);
                  const msg = document.getElementById('copy-message');
                  if (msg) {
                    msg.style.display = 'inline';
                    setTimeout(() => { msg.style.display = 'none'; }, 1500);
                  }
                }
              </script>
            `));
            controller.close();
          }
        });
        return new Response(wrapperStream, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } else {
        return c.text("We were unable to generate output", 500);
      }
    }
  } catch (error) {
    return c.text("An error occurred while processing your request.", 500);
  }
});

// POST "/upload" - Handle file uploads, save to R2, and schedule background processing
app.post("/upload", async (c) => {
  try {
    const formData = await c.req.parseBody();
    const file = formData?.file;
    if (!file) {
      return c.json({ success: false, message: "No file provided" }, 400);
    }
    if (!(file instanceof File) || !ALLOWED_FILE_TYPES.includes(file.type)) {
      return c.json({ success: false, message: `Unsupported file type: ${file instanceof File ? file.type : 'unknown'}` }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ success: false, message: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);
    }
    const now = new Date().toISOString();
    const uploader = c.req.header("X-User") || "anonymous";
    await c.env.R2.put(file.name, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        uploaded_at: now,
        uploader,
      }
    });
    // Schedule background processing
    await MyAgent.schedule("reindex-doc", { filename: file.name, uploader });
    return c.json({ success: true, message: "File uploaded to R2 and scheduled for processing." });
  } catch (error) {
    return c.json({ success: false, message: error instanceof Error ? error.message : "Failed to parse file" }, 400);
  }
});

// GET "/files/:filename" - Retrieve files from R2 bucket
app.get("/files/:filename", async (c) => {
  const { filename } = c.req.param();
  const authKey = c.req.header("X-Upload-Auth-Key");

  if (!authKey || authKey !== UPLOAD_AUTH_KEY) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    const object = await c.env.R2.get(filename);
    if (object === null) {
      return c.json({ success: false, message: "File not found" }, 404);
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  } catch (error) {
    console.error("File retrieval error:", error);
    return c.json({ success: false, message: "An error occurred while retrieving the file" }, 500);
  }
});

// Middleware to check for R2 bucket configuration
app.use(async (c, next) => {
  if (!c.env.R2) {
    console.error("R2 bucket rfp-docs is not configured");
    return c.text("R2 bucket not configured", 500);
  }
  return next();
});

// GET "/autorag-test" - Example endpoint for autorag AI search
app.get("/autorag-test", async (c) => {
  const answer = await c.env.AI.autorag("autorag-test").aiSearch({
    query: c.req.query("q") ?? "",
  });
  return c.json({ answer });
});

// GET "/autorag" - Production endpoint for autorag AI search
app.get("/autorag", async (c) => {
  const answer = await c.env.AI.autorag("autorag-test").aiSearch({
    query: c.req.query("q") ?? "",
  });
  return c.json({ answer });
});

// GET "/notes" - Retrieve all notes (Q&A pairs) from the database
app.get("/notes", async (c) => {
  const { results } = await c.env.DATABASE.prepare("SELECT * FROM questions ORDER BY id DESC").all<QA_Pair>();
  return c.json(results);
});
// =======================
// Vision (LLaVA) Endpoint
// =======================

app.post("/vision", async (c) => {
  try {
    const formData = await c.req.parseBody();
    const file = formData?.file;
    const question = formData?.question;

    if (!file || !(file instanceof File)) {
      return c.json({ success: false, message: "No image file provided" }, 400);
    }
    if (!question || typeof question !== "string") {
      return c.json({ success: false, message: "No question provided" }, 400);
    }

    // Read image as base64
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    // Call Cloudflare Workers AI LLaVA model
    const result = await c.env.AI.run("@cf/llava-1.5-7b-hf", {
      prompt: question,
      image: base64,
    });

    return c.json({ success: true, answer: result });
  } catch (error) {
    console.error("Vision endpoint error:", error);
    return c.json({ success: false, message: "Failed to process vision request" }, 500);
  }
});
// =======================
// End Vision (LLaVA) Endpoint
// =======================

// =======================
// Type Definitions
// =======================
type Env = {
  AI: any;
  ANTHROPIC_API_KEY: string;
  DATABASE: D1Database;
  ENABLE_TEXT_SPLITTING: boolean | undefined;
  RAG_WORKFLOW: any; // Workflow type is not imported, so use any
  VECTOR_INDEX?: VectorizeIndex;
  R2: R2Bucket;
};

type QA_Pair = {
  id: string;
  question: string;
  answer: string;
};

type Params = {
  text: string;
};

type D1Database = {
  prepare: (query: string) => {
    bind: (...args: any[]) => {
      all: <T = any>() => Promise<{ results: T[] }>;
      run: <T = any>() => Promise<{ results: T[] }>;
    };
  };
};

type VectorizeIndex = {
  describe: () => Promise<any>;
  insert: (vectors: { id: string; values: number[]; metadata?: { text: string } }[]) => Promise<any>;
  deleteByIds: (ids: string[]) => Promise<any>;
  getByIds: (ids: string[]) => Promise<any>;
  query: (vectors: number[][], options: { topK: number }) => Promise<{ matches: any[]; count: number }>;
  upsert: (vectors: { id: string; values: number[]; metadata?: { text: string } }[]) => Promise<any>;
};

type R2Bucket = {
  put: (key: string, value: ArrayBuffer, options?: any) => Promise<any>;
  get: (key: string) => Promise<any>;
};

export type CrawlAndSummarizeResult = {
  url: string;
  title: string;
  summary: string;
  error?: string;
}[];

// =======================
// End Type Definitions
// =======================

// =======================
// Exported Functions and Classes
// =======================
// Export helper for testing and workflows
export async function initExports() {
  return {
    app,
    extractTextFromFile,
    processDocument,
    RAGWorkflow,
  };
}

// RAGWorkflow class for advanced workflow processing
export class RAGWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const env = this.env;
    const { text } = event.payload;
    let texts: string[] = [text];

    if (env.ENABLE_TEXT_SPLITTING) {
      texts = await step.do("split text", async () => {
        const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 512, chunkOverlap: 32, separators: ["\n\n", "\n", ".", " "], });
        const output = await splitter.createDocuments([text]);
        return output.map(doc => doc.pageContent);
      });
      console.log(`RecursiveCharacterTextSplitter generated ${texts.length} chunks`);
    }

    for (const index in texts) {
      const text = texts[index];
      const record = await step.do(`create database record: ${index}/${texts.length}`, async () => {
        const query = "INSERT INTO questions (question, answer) VALUES (?, ?) RETURNING *";
        const { results } = await env.DATABASE.prepare(query).bind(text, "Placeholder answer").run<QA_Pair>();
        const record = results[0];
        if (!record) throw new Error("Failed to create QA pair");
        return record;
      });
    
      const embedding = await step.do(`generate embedding: ${index}/${texts.length}`, async () => {
        const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: text });
        const values = embeddings.data[0];
        if (!values) throw new Error("Failed to generate vector embedding");
        return values;
      });
    
      await step.do(`insert vector: ${index}/${texts.length}`, async () => {
        if (!env.VECTOR_INDEX) {
          console.warn("VECTOR_INDEX is not defined. Using mock data for local testing.");
          env.VECTOR_INDEX = {
            describe: async () => ({
              id: "mock-id",
              name: "mock-index",
              dimensions: 768,
              config: { dimensions: 768, metric: "cosine", shardCount: 1 },
              vectorsCount: 0
            }),
            insert: async (vectors) => ({ ids: vectors.map((_, index) => `mock-id-${index}`), count: vectors.length }),
            deleteByIds: async (ids) => ({ ids, count: ids.length }),
            getByIds: async (ids) => ids.map(id => ({ id, values: new Array(768).fill(0) })),
            query: async (vectors, options) => ({
              matches: [{ id: "mock-id", score: 0.9 }],
              count: 1,
            }),
            upsert: async (vectors) => {
              console.log("Mock VECTOR_INDEX upsert:", vectors);
              return { ids: vectors.map((_, index) => `mock-id-${index}`), count: vectors.length };
            },
          };
        }
        if (!env.VECTOR_INDEX) throw new Error("VECTOR_INDEX is not defined.");
        return env.VECTOR_INDEX.upsert([{ id: record.id.toString(), values: embedding }]);
      });
    }    
    
  }
}
// =======================
// End Exported Functions and Classes
// =======================

export default app;