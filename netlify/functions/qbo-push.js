// netlify/functions/qbo-push.js
// Proxies QBO API calls from the browser to avoid CORS restrictions.
// Accepts: { accessToken, realmId, endpoint, method, payload }

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: 'Invalid JSON' };
  }

  const { accessToken, realmId, endpoint, method, payload } = body;

  if (!accessToken || !realmId || !endpoint) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing accessToken, realmId, or endpoint' })
    };
  }

  const baseUrl = `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}`;
  const url = `${baseUrl}/${endpoint}${endpoint.includes('?') ? '&' : '?'}minorversion=65`;

  const fetchOpts = {
    method: method || 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  };

  if (payload && (method === 'POST' || method === 'PUT')) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(payload);
  }

  try {
    const res = await fetch(url, fetchOpts);
    const data = await res.text();

    return {
      statusCode: res.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: data
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'proxy_error', message: err.message })
    };
  }
};
