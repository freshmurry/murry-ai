import { Agent, unstable_callable } from "agents";
import { Document, Packer, Paragraph, TextRun } from "docx"; // for Word
import { PDFDocument } from "pdf-lib"; // for PDF
import ExcelJS from "exceljs"; // Add this import

export class MyAgent extends Agent<any, any> {
  @unstable_callable({ description: "Generate a Word document" })
  async generateWordDoc(content: string): Promise<string> {
    const doc = new Document({ sections: [{ children: [new Paragraph(content)] }] });
    const buffer = await Packer.toBuffer(doc);
    const url = await uploadToStorage(this.env, buffer, "document.docx");
    return url;
  }

  @unstable_callable({ description: "Generate a PDF document" })
  async generatePdfDoc(content: string): Promise<string> {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    page.drawText(content);
    const pdfBytes = await pdfDoc.save();
    const url = await uploadToStorage(this.env, pdfBytes, "document.pdf");
    return url;
  }

  @unstable_callable({ description: "Generate an XLS document from stored content" })
  async generateXlsDoc(): Promise<string> {
    const data = await this.getSomeStoredContent();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sheet1");

    if (Array.isArray(data) && data.length > 0) {
      worksheet.columns = Object.keys(data[0]).map(key => ({ header: key, key }));
      worksheet.addRows(data);
    } else {
      worksheet.getCell("A1").value = "No data available";
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const url = await uploadToStorage(this.env, new Uint8Array(buffer), "document.xlsx");
    return url;
  }

  @unstable_callable({ description: "Fill RFP XLS with R2 data" })
  async fillRfpXlsDoc(uploadedXlsBuffer: Buffer): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(uploadedXlsBuffer);

    const rfpData = await this.fetchRfpDataFromR2();

    const worksheet = workbook.getWorksheet(1);
    if (worksheet) {
      worksheet.getCell("B2").value = rfpData.companyName;
      worksheet.getCell("B3").value = rfpData.contactEmail;
    }

    const filledBuffer = await workbook.xlsx.writeBuffer();
    const url = await uploadToStorage(this.env, new Uint8Array(filledBuffer), "filled-rfp.xlsx");
    return url;
  }

  @unstable_callable({ description: "Fill RFP XLS with R2 data, with human-in-the-loop if uncertain" })
  async fillRfpXlsDocWithApproval(
    uploadedXlsBuffer: Buffer,
    approval?: { cells: { sheet: string, cell: string, value: any }[] }
  ): Promise<{ status: string, pending?: any, url?: string }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(uploadedXlsBuffer);

    const rfpData = await this.fetchRfpDataFromR2();

    const worksheet = workbook.getWorksheet(1);
    const suggestions: { sheet: string, cell: string, value: any }[] = [];

    let foundCompany = false;
    if (worksheet) worksheet.eachRow((row: ExcelJS.Row, rowNumber: number) => {
      row.eachCell((cell: ExcelJS.Cell, colNumber) => {
        if (typeof cell.value === "string" && cell.value.toLowerCase().includes("company")) {
          worksheet.getCell(rowNumber, colNumber + 1).value = rfpData.companyName;
          foundCompany = true;
        }
      });
    });
    if (!foundCompany) {
      if (worksheet) {
        suggestions.push({ sheet: worksheet.name, cell: "Unknown", value: rfpData.companyName });
      }
    }

    if (suggestions.length > 0 && !approval) {
      return {
        status: "pending_approval",
        pending: suggestions
      };
    }

    if (approval && approval.cells) {
      for (const { sheet, cell, value } of approval.cells) {
        const ws = workbook.getWorksheet(sheet);
        if (ws) ws.getCell(cell).value = value;
      }
    }

    const filledBuffer = await workbook.xlsx.writeBuffer();
    const url = await uploadToStorage(this.env, new Uint8Array(filledBuffer), "filled-rfp.xlsx");
    return {
      status: "completed",
      url
    };
  }

  @unstable_callable({ description: "Fill RFP Word docx with R2 data" })
  async fillRfpWordDocx(uploadedDocxBuffer: Buffer): Promise<string> {
    const rfpData = await this.fetchRfpDataFromR2();
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: `Company Name: ${rfpData.companyName}`, bold: true }),
            ],
            spacing: { after: 200 },
          }),
        ],
      }],
    });
    const buffer = await Packer.toBuffer(doc);
    const url = await uploadToStorage(this.env, buffer, "filled-rfp.docx");
    return url;
  }

  @unstable_callable({ description: "Summarize text using Workers AI" })
  async summarizeText(text: string): Promise<string> {
    // Replace YOUR_ACCOUNT_ID and YOUR_API_TOKEN with your actual values
    const response = await fetch("https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/run/@cf/meta/llama-3.3-70b-instruct-fsp", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.YOUR_API_TOKEN || "your-default-api-token"}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: `Summarize the following:\n${text}`
      })
    });
    const result = await response.json() as { result?: { response?: string } };
    return result.result?.response || "No summary available.";
  }

  @unstable_callable({ description: "Perform a web search and summarize results" })
  async searchAndSummarize(query: string): Promise<string> {
    const searchRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
    const data = await searchRes.json();
    const summary = (data as { Abstract?: string }).Abstract || "No summary found.";
    return summary;
  }

  @unstable_callable({ description: "Fetch and summarize the main content from a web page using Browser Rendering and Workers AI" })
  async fetchAndSummarizeFirstBlogPost(
    url: string,
    options?: { selector?: string; script?: string }
  ): Promise<{ title: string; summary: string; error?: string }> {
    const browserRenderingApi = "https://browser.rendering.cloudflare.com/render";
    const selector =
      options?.selector ||
      "article, .post, .blog-post, main, section, .content, body";
    const script =
      options?.script ||
      `
        const el = document.querySelector('${selector}');
        if (el) {
          let title = '';
          title = el.querySelector('h1, h2, .title')?.innerText
            || document.title
            || '';
          const content = el.innerText || '';
          return { title, content };
        }
        if (document.body) {
          return { title: document.title || '', content: document.body.innerText || '' };
        }
        return { title: '', content: '' };
      `;

    let renderingResult: any = {};
    try {
      const renderingResponse = await fetch(browserRenderingApi, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          script
        })
      });
      if (!renderingResponse.ok) {
        return { title: '', summary: '', error: `Browser rendering failed: ${renderingResponse.statusText}` };
      }
      const renderingJson = await renderingResponse.json();
      if (typeof renderingJson === "object" && renderingJson !== null && "result" in renderingJson) {
        renderingResult = (renderingJson as { result?: any }).result || {};
      } else {
        renderingResult = {};
      }
    } catch (err) {
      return { title: '', summary: '', error: `Browser rendering error: ${err instanceof Error ? err.message : String(err)}` };
    }

    const { title = '', content = '' } = renderingResult;
    if (!content || content.trim().length < 10) {
      return { title, summary: '', error: "Could not extract meaningful content from the page." };
    }

    let summary = content;
    try {
      const aiResponse = await fetch(
        "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/run/@cf/meta/llama-3.3-70b-instruct-fsp",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.YOUR_API_TOKEN || "your-default-api-token"}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            prompt: `Summarize the following web page content:\n${content}`
          })
        }
      );
      if (!aiResponse.ok) {
        return { title, summary: content, error: `AI summarization failed: ${aiResponse.statusText}` };
      }
      const aiResult = await aiResponse.json() as { result?: { response?: string } };
      summary = aiResult.result?.response || content;
    } catch (err) {
      return { title, summary: content, error: `AI summarization error: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { title, summary };
  }

  @unstable_callable({ description: "Crawl a website up to a certain depth and summarize each page using Browser Rendering and Workers AI" })
  async crawlWebsiteAndSummarize(
    startUrl: string,
    options?: { maxPages?: number; maxDepth?: number; sameOriginOnly?: boolean }
  ): Promise<{ url: string; title: string; summary: string; error?: string }[]> {
    const visited = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
    const results: { url: string; title: string; summary: string; error?: string }[] = [];
    const maxPages = options?.maxPages ?? 10;
    const maxDepth = options?.maxDepth ?? 2;
    const sameOriginOnly = options?.sameOriginOnly ?? true;
    const origin = new URL(startUrl).origin;

    while (queue.length > 0 && results.length < maxPages) {
      const { url, depth } = queue.shift()!;
      if (visited.has(url) || depth > maxDepth) continue;
      visited.add(url);

      const pageResult = await this.fetchAndSummarizeFirstBlogPost(url);
      results.push({ url, ...pageResult });

      if (depth < maxDepth) {
        try {
          const browserRenderingApi = "https://browser.rendering.cloudflare.com/render";
          const linkScript = `
            return Array.from(document.querySelectorAll('a[href]'))
              .map(a => a.href)
              .filter(href => href.startsWith('http'));
          `;
          const renderingResponse = await fetch(browserRenderingApi, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, script: linkScript })
          });
          if (renderingResponse.ok) {
            const renderingJson = await renderingResponse.json();
            const links: string[] = (renderingJson as { result?: string[] }).result || [];
            for (const link of links) {
              if (
                !visited.has(link) &&
                (!sameOriginOnly || new URL(link).origin === origin)
              ) {
                queue.push({ url: link, depth: depth + 1 });
              }
              if (queue.length + results.length >= maxPages) break;
            }
          }
        } catch {
          // Ignore link extraction errors
        }
      }
    }
    return results;
  }

  async getSomeStoredContent(): Promise<any[]> {
    return [
      { Name: "Alice", Score: 95 },
      { Name: "Bob", Score: 88 }
    ];
  }

  async fetchRfpDataFromR2(): Promise<any> {
    // Implement logic to fetch data from R2
    return {
      companyName: "Acme Corp",
      contactEmail: "info@acme.com",
    };
  }
}

// Helper function to upload buffer to storage and return a URL
async function uploadToStorage(env: any, buffer: Uint8Array, filename: string): Promise<string> {
  // Example for Cloudflare Worker with R2 binding named "R2"
  // This function must be called with access to the env object
  await env.R2.put(filename, buffer);
  // Construct a public URL if you have public access enabled
  return `https://<your-account-id>.r2.cloudflarestorage.com/${filename}`;
}
