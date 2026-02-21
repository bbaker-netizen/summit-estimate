exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { subitemId, pdfBase64, fileName, token, boardId, fileColId } = body;

  if (!subitemId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: subitemId' }) };
  }

  // If no PDF, nothing to upload
  if (!pdfBase64) {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No PDF to upload' }) };
  }

  if (!token) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token for file upload' }) };
  }

  try {
    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const safeFileName = fileName || ('estimate_' + subitemId + '.pdf');

    // Find the file column
    let targetBoardId = boardId;
    let targetFileColId = fileColId;

    if (!targetFileColId) {
      // Query subitem to find its board and columns
      const subQuery = JSON.stringify({
        query: '{ items(ids:[' + subitemId + ']){ board{ id columns{ id title type } } } }'
      });
      const subRes = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token },
        body: subQuery
      });
      const subData = await subRes.json();
      console.log('Column query result:', JSON.stringify(subData).substring(0, 500));
      const board = subData?.data?.items?.[0]?.board;
      if (board) {
        targetBoardId = board.id;
        const fCol = (board.columns || []).find(c => c.type === 'file' || c.title.toLowerCase().includes('estimate doc'));
        targetFileColId = fCol?.id;
        console.log('Found file col:', targetFileColId, 'board:', targetBoardId);
      }
    }

    if (!targetFileColId || !targetBoardId) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Could not find file column', subitemId, targetBoardId }) };
    }

    // Upload file to Monday using multipart upload mutation
    const mutation = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + subitemId + ', column_id: "' + targetFileColId + '", file: $file) { id } }';
    const boundary = 'FormBoundary' + Date.now();
    const encoder = new TextEncoder();

    const operationsJson = JSON.stringify({ query: mutation, variables: { file: null } });
    const mapJson = JSON.stringify({ '0': ['variables.file'] });

    const opsStr = '--' + boundary + '\r\nContent-Disposition: form-data; name="operations"\r\n\r\n' + operationsJson + '\r\n';
    const mapStr = '--' + boundary + '\r\nContent-Disposition: form-data; name="map"\r\n\r\n' + mapJson + '\r\n';
    const fileHeaderStr = '--' + boundary + '\r\nContent-Disposition: form-data; name="0"; filename="' + safeFileName + '"\r\nContent-Type: application/pdf\r\n\r\n';
    const footerStr = '\r\n--' + boundary + '--\r\n';

    const opsBytes = encoder.encode(opsStr);
    const mapBytes = encoder.encode(mapStr);
    const fileHeaderBytes = encoder.encode(fileHeaderStr);
    const footerBytes = encoder.encode(footerStr);
    const pdfBytes = new Uint8Array(pdfBuffer);

    const totalLen = opsBytes.length + mapBytes.length + fileHeaderBytes.length + pdfBytes.length + footerBytes.length;
    const combined = new Uint8Array(totalLen);
    let off = 0;
    combined.set(opsBytes, off); off += opsBytes.length;
    combined.set(mapBytes, off); off += mapBytes.length;
    combined.set(fileHeaderBytes, off); off += fileHeaderBytes.length;
    combined.set(pdfBytes, off); off += pdfBytes.length;
    combined.set(footerBytes, off);

    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      body: combined
    });

    const uploadText = await uploadRes.text();
    console.log('Upload HTTP status:', uploadRes.status);
    console.log('Upload response:', uploadText.substring(0, 300));

    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch(e) { uploadData = { raw: uploadText.substring(0, 200) }; }

    if (uploadData?.data?.add_file_to_column?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, fileId: uploadData.data.add_file_to_column.id }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, detail: uploadData, uploadStatus: uploadRes.status }) };
    }

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
