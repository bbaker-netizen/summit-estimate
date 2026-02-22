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
  console.log('subitemId int:', subitemIdInt, 'parentItemId int:', parentItemIdInt);
  console.log('Token prefix:', apiToken.substring(0, 20));

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const safeFileName = (fileName || ('estimate_' + subitemIdInt + '.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');
    console.log('PDF size:', pdfBuffer.length, 'fileName:', safeFileName);

    // Step 1: Find file column - check parent board first
    let targetItemId = subitemIdInt;
    let targetFileColId = fileColId;

    if (!targetFileColId && parentItemIdInt) {
      const parentQuery = JSON.stringify({
        query: '{ items(ids:[' + parentItemIdInt + ']){ board{ id columns{ id title type } } } }'
      });
      const parentRes = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiToken },
        body: parentQuery
      });
      const parentData = await parentRes.json();
      const parentCols = parentData?.data?.items?.[0]?.board?.columns || [];
      console.log('Parent board cols:', JSON.stringify(parentCols));
      const fCol = parentCols.find(c => c.type === 'file');
      if (fCol) {
        targetFileColId = fCol.id;
        targetItemId = parentItemIdInt;
        console.log('Using parent item', targetItemId, 'col:', targetFileColId, fCol.title);
      } else {
        console.log('No file type col on parent board - checking subitem board');
        const subQuery = JSON.stringify({
          query: '{ items(ids:[' + subitemIdInt + ']){ board{ id columns{ id title type } } } }'
        });
        const subRes = await fetch('https://api.monday.com/v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': apiToken },
          body: subQuery
        });
        const subData = await subRes.json();
        const subCols = subData?.data?.items?.[0]?.board?.columns || [];
        console.log('Sub board cols:', JSON.stringify(subCols));
        const sfCol = subCols.find(c => c.type === 'file');
        if (sfCol) {
          targetFileColId = sfCol.id;
          targetItemId = subitemIdInt;
          console.log('Using subitem', targetItemId, 'col:', targetFileColId, sfCol.title);
        }
      }
    }

    if (!targetFileColId) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No file column found' }) };
    }

    // Step 2: Upload using manual Buffer with actual CRLF bytes (0x0D 0x0A)
    const CRLF = Buffer.from([0x0d, 0x0a]);
    const mutation = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + targetItemId + ', column_id: "' + targetFileColId + '", file: $file) { id } }';
    console.log('Mutation:', mutation);

    const operations = JSON.stringify({ query: mutation, variables: { file: null } });
    const map = JSON.stringify({ '0': ['variables.file'] });
    const boundary = 'MondayBoundary' + Date.now();

    function makePart(name, value) {
      return Buffer.concat([
        Buffer.from('--' + boundary, 'utf8'), CRLF,
        Buffer.from('Content-Disposition: form-data; name="' + name + '"', 'utf8'), CRLF,
        CRLF,
        Buffer.from(value, 'utf8'), CRLF
      ]);
    }
    function makeFilePart(name, filename, contentType, fileBuffer) {
      return Buffer.concat([
        Buffer.from('--' + boundary, 'utf8'), CRLF,
        Buffer.from('Content-Disposition: form-data; name="' + name + '"; filename="' + filename + '"', 'utf8'), CRLF,
        Buffer.from('Content-Type: ' + contentType, 'utf8'), CRLF,
        CRLF,
        fileBuffer, CRLF
      ]);
    }

    const bodyBuffer = Buffer.concat([
      makePart('operations', operations),
      makePart('map', map),
      makeFilePart('0', safeFileName, 'application/pdf', pdfBuffer),
      Buffer.from('--' + boundary + '--', 'utf8'), CRLF
    ]);

    console.log('Total upload bytes:', bodyBuffer.length);

    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        'Authorization': apiToken,
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      body: bodyBuffer
    });

    const uploadText = await uploadRes.text();
    console.log('Upload status:', uploadRes.status);
    console.log('Upload response:', uploadText);

    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch(e) { uploadData = { raw: uploadText }; }

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
