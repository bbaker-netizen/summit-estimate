const https = require('https');

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

  const { subitemId, parentItemId, pdfBase64, fileName, boardId, fileColId } = body;
  if (!subitemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subitemId' }) };
  if (!pdfBase64) return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No PDF to upload' }) };

  const apiToken = process.env.MONDAY_API_TOKEN;
  if (!apiToken) return { statusCode: 500, headers, body: JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }) };

  const subitemIdInt = parseInt(subitemId, 10);
  const parentItemIdInt = parentItemId ? parseInt(parentItemId, 10) : null;
  console.log('subitemId int:', subitemIdInt);
  console.log('Token prefix:', apiToken.substring(0, 20));

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const safeFileName = (fileName || ('estimate_' + subitemIdInt + '.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');
    console.log('PDF size:', pdfBuffer.length, 'file:', safeFileName);

    // Step 1: Find file column
    let targetItemId = subitemIdInt;
    let targetFileColId = fileColId;

    if (!targetFileColId) {
      const colRes = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiToken },
        body: JSON.stringify({ query: '{ items(ids:[' + subitemIdInt + ']){ board{ columns{ id title type } } } }' })
      });
      const colData = await colRes.json();
      const cols = colData?.data?.items?.[0]?.board?.columns || [];
      console.log('Cols:', JSON.stringify(cols));
      const fCol = cols.find(c => c.type === 'file');
      if (fCol) { targetFileColId = fCol.id; console.log('File col:', fCol.id, fCol.title); }
    }

    if (!targetFileColId) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No file column found' }) };
    }

    // Step 2: Upload via https module (direct control, explicit Content-Length)
    const mutation = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + targetItemId + ', column_id: "' + targetFileColId + '", file: $file) { id } }';
    console.log('Mutation:', mutation);

    const operations = JSON.stringify({ query: mutation, variables: { file: null } });
    const map = JSON.stringify({ '0': ['variables.file'] });
    const boundary = 'MondayUploadBoundary' + Date.now();
    const CRLF = Buffer.from([0x0d, 0x0a]);

    // Build multipart body
    function part(name, value) {
      return Buffer.concat([
        Buffer.from('--' + boundary), CRLF,
        Buffer.from('Content-Disposition: form-data; name="' + name + '"'), CRLF,
        CRLF,
        Buffer.from(value, 'utf8'), CRLF
      ]);
    }
    function filePart(name, fname, mime, buf) {
      return Buffer.concat([
        Buffer.from('--' + boundary), CRLF,
        Buffer.from('Content-Disposition: form-data; name="' + name + '"; filename="' + fname + '"'), CRLF,
        Buffer.from('Content-Type: ' + mime), CRLF,
        CRLF,
        buf, CRLF
      ]);
    }
    const bodyBuf = Buffer.concat([
      part('operations', operations),
      part('map', map),
      filePart('0', safeFileName, 'application/pdf', pdfBuffer),
      Buffer.from('--' + boundary + '--'), CRLF
    ]);

    console.log('Upload body length:', bodyBuf.length);

    // Use Node https module for upload
    const uploadResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.monday.com',
        path: '/v2/file',
        method: 'POST',
        headers: {
          'Authorization': apiToken,
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': bodyBuf.length
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          console.log('Upload status:', res.statusCode);
          console.log('Upload response:', data);
          resolve({ status: res.statusCode, body: data });
        });
      });
      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });

    let uploadData;
    try { uploadData = JSON.parse(uploadResult.body); } catch(e) { uploadData = { raw: uploadResult.body }; }

    if (uploadData?.data?.add_file_to_column?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, fileId: uploadData.data.add_file_to_column.id }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, uploadStatus: uploadResult.status, detail: uploadData }) };
    }

  } catch (err) {
    console.error('Error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
