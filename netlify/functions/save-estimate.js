exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { subitemId, pdfBase64, fileName, boardId, fileColId } = body;
  if (!subitemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subitemId' }) };
  if (!pdfBase64) return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No PDF to upload' }) };

  const apiToken = process.env.MONDAY_API_TOKEN;
  if (!apiToken) return { statusCode: 500, headers, body: JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }) };

  // Ensure subitemId is integer
  const subitemIdInt = parseInt(subitemId, 10);
  console.log('subitemId:', subitemId, '-> int:', subitemIdInt);
  console.log('Token prefix:', apiToken.substring(0, 20));
  console.log('Token length:', apiToken.length);

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    console.log('PDF buffer size:', pdfBuffer.length);
    const safeFileName = (fileName || ('estimate_' + subitemIdInt + '.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');

    // Step 1: Find file column via subitem query
    let targetBoardId = boardId;
    let targetFileColId = fileColId;

    if (!targetFileColId) {
      const subQuery = JSON.stringify({
        query: '{ items(ids:[' + subitemIdInt + ']){ board{ id columns{ id title type } } } }'
      });
      const subRes = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiToken,
          'API-Version': '2024-01'
        },
        body: subQuery
      });
      const subText = await subRes.text();
      console.log('Column query status:', subRes.status);
      console.log('Column query result:', subText.substring(0, 500));
      if (subRes.status !== 200) {
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Monday API auth failed', status: subRes.status }) };
      }
      const subData = JSON.parse(subText);
      const board = subData?.data?.items?.[0]?.board;
      if (board) {
        targetBoardId = board.id;
        const cols = board.columns || [];
        console.log('All columns:', JSON.stringify(cols.map(c => ({ id: c.id, title: c.title, type: c.type }))));
        const fCol = cols.find(c =>
          c.type === 'file' ||
          (c.title || '').toLowerCase().includes('estimate') ||
          (c.title || '').toLowerCase().includes('doc') ||
          (c.title || '').toLowerCase().includes('attach')
        );
        targetFileColId = fCol?.id;
        console.log('Chosen file col:', targetFileColId, fCol?.title);
      } else {
        console.log('No board found in subitem query. Data:', JSON.stringify(subData).substring(0, 300));
      }
    }

    if (!targetFileColId) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No file column found', subitemId: subitemIdInt, boardId: targetBoardId }) };
    }

    // Step 2: Upload file via multipart GraphQL
    const mutation = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + subitemIdInt + ', column_id: "' + targetFileColId + '", file: $file) { id } }';
    console.log('Mutation:', mutation);

    const boundary = 'Boundary' + Date.now();
    const operationsJson = JSON.stringify({ query: mutation, variables: { file: null } });
    const mapJson = JSON.stringify({ '0': ['variables.file'] });

    const enc = (s) => Buffer.from(s, 'utf8');
    const CRLF = '\r\n';
    const parts = [
      enc('--' + boundary + CRLF + 'Content-Disposition: form-data; name="operations"' + CRLF + CRLF + operationsJson + CRLF),
      enc('--' + boundary + CRLF + 'Content-Disposition: form-data; name="map"' + CRLF + CRLF + mapJson + CRLF),
      enc('--' + boundary + CRLF + 'Content-Disposition: form-data; name="0"; filename="' + safeFileName + '"' + CRLF + 'Content-Type: application/pdf' + CRLF + CRLF),
      pdfBuffer,
      enc(CRLF + '--' + boundary + '--' + CRLF)
    ];

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const combined = Buffer.allocUnsafe(totalLen);
    let off = 0;
    for (const p of parts) { p.copy(combined, off); off += p.length; }

    console.log('Uploading to Monday, boundary:', boundary, 'total bytes:', totalLen);

    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        'Authorization': apiToken,
        'API-Version': '2024-01',
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      body: combined
    });

    const uploadText = await uploadRes.text();
    console.log('Upload status:', uploadRes.status);
    console.log('Upload response:', uploadText.substring(0, 600));

    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch(e) { uploadData = { raw: uploadText.substring(0, 300) }; }

    if (uploadData?.data?.add_file_to_column?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, fileId: uploadData.data.add_file_to_column.id }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, uploadStatus: uploadRes.status, detail: uploadData }) };
    }

  } catch (err) {
    console.error('Error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
