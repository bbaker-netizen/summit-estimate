exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method not allowed" };
  try {
    const body = JSON.parse(event.body);
    const { subitemId, pdfBase64, fileName } = body;
    const apiToken = process.env.MONDAY_API_TOKEN;
    console.log("Request:", { subitemId, hasPdf: !!pdfBase64, pdfLen: pdfBase64 ? pdfBase64.length : 0, fileName, hasToken: !!apiToken });
    if (!subitemId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing subitemId" }) };
    if (!pdfBase64) return { statusCode: 200, headers, body: JSON.stringify({ success: true, note: "No PDF to upload" }) };
    if (!apiToken) return { statusCode: 500, headers, body: JSON.stringify({ error: "Server missing API token" }) };
    // Step 1: Find sub-item board and file column
    const colQuery = "{ items(ids:[" + subitemId + "]){ board { id columns { id title type } } } }";
    console.log("Column query:", colQuery);
    const colResp = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": apiToken, "API-Version": "2024-10" },
      body: JSON.stringify({ query: colQuery })
    });
    const colData = await colResp.json();
    console.log("Column response:", JSON.stringify(colData).substring(0, 500));
    if (colData.errors) return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Column query: " + JSON.stringify(colData.errors) }) };
    const board = colData.data && colData.data.items && colData.data.items[0] && colData.data.items[0].board;
    if (!board) return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Board not found for subitem " + subitemId }) };
    const fileCol = board.columns.find(c => c.type === "file");
    if (!fileCol) return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "No file column on board " + board.id }) };
    console.log("Board:", board.id, "File column:", fileCol.id);
    // Step 2: Upload PDF via multipart
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const boundary = "----FormBoundary" + Date.now();
    const mutation = "mutation ($file: File!) { add_file_to_column (item_id: " + subitemId + ", column_id: \"" + fileCol.id + "\", file: $file) { id } }";
    const parts = [];
    parts.push("--" + boundary);
    parts.push("Content-Disposition: form-data; name=\"query\"");
    parts.push("");
    parts.push(mutation);
    parts.push("--" + boundary);
    parts.push("Content-Disposition: form-data; name=\"variables[file]\"; filename=\"" + (fileName || "estimate.pdf") + "\"");
    parts.push("Content-Type: application/pdf");
    parts.push("");
    const textPart = parts.join("\r\n") + "\r\n";
    const textBuf = Buffer.from(textPart);
    const endBuf = Buffer.from("\r\n--" + boundary + "--\r\n");
    const fullBody = Buffer.concat([textBuf, pdfBuffer, endBuf]);
    console.log("Uploading PDF:", pdfBuffer.length, "bytes, mutation:", mutation);
    const uploadResp = await fetch("https://api.monday.com/v2/file", {
      method: "POST",
      headers: { "Authorization": apiToken, "Content-Type": "multipart/form-data; boundary=" + boundary, "API-Version": "2024-10" },
      body: fullBody
    });
    const uploadText = await uploadResp.text();
    console.log("Upload status:", uploadResp.status, "Response:", uploadText.substring(0, 500));
    if (uploadResp.status === 200) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: "PDF uploaded", response: uploadText.substring(0, 200) }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Upload HTTP " + uploadResp.status + ": " + uploadText.substring(0, 200) }) };
    }
  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
