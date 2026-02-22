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

    // Step 1: Query parent item board columns to find file column
    let targetItemId = subitemIdInt;
    let targetFileColId = fileColId;

    if (!targetFileColId && parentItemIdInt) {
      // Query parent item's board columns
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
      const fCol = parentCols.find(c =>
        c.type === 'file' ||
        (c.title || '').toLowerCase().includes('estimate') ||
        (c.title || '').toLowerCase().includes('doc')
      );
      if (fCol) {
        targetFileColId = fCol.id;
        targetItemId = parentItemIdInt; // attach to parent item
        console.log('Using parent item col:', targetFileColId, fCol.title);
      }
    }

    if (!targetFileColId) {
      // Fall back: query subitem board
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
      const fCol = subCols.find(c =>
        c.type === 'file' ||
        (c.title || '').toLowerCase().includes('estimate') ||
        (c.title || '').toLowerCase().includes('doc')
      );
      if (fCol) {
        targetFileColId = fCol.id;
        targetItemId = subitemIdInt;
        console.log('Using subitem col:', targetFileColId, fCol.title);
      }
    }

    if (!targetFileColId) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No file column found' }) };
    }

    console.log('Uploading to item:', targetItemId, 'col:', targetFileColId);

    // Step 2: Upload via FormData
    const mutation = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + targetItemId + ', column_id: "' + targetFileColId + '", file: $file) { id } }';
    console.log('Mutation:', mutation);

    const operations = JSON.stringify({ query: mutation, variables: { file: null } });
    const map = JSON.stringify({ '0': ['variables.file'] });

    const form = new FormData();
    form.append('operations', operations);
    form.append('map', map);
    form.append('0', new Blob([pdfBuffer], { type: 'application/pdf' }), safeFileName);

    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: { 'Authorization': apiToken },
      body: form
    });

    const uploadText = await uploadRes.text();
    console.log('Upload status:', uploadRes.status);
    console.log('Upload response:', uploadText);

    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch(e) { uploadData = { raw: uploadText }; }

    if (uploadData?.data?.add_file_to_column?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, fileId: uploadData.data.add_file_to_column.id, itemId: targetItemId, colId: targetFileColId }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, uploadStatus: uploadRes.status, detail: uploadData }) };
    }

  } catch (err) {
    console.error('Error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
