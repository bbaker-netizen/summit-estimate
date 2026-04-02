// netlify/functions/qbo-token.js
// Exchanges an OAuth authorization code for QBO access + refresh tokens.
// The client_secret lives only here, server-side, never in the browser.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { code, realmId, redirectUri } = body;
  if (!code || !realmId) {
    return { statusCode: 400, body: 'Missing code or realmId' };
  }

  const clientId     = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { statusCode: 500, body: 'QBO credentials not configured' };
  }

  const redirect = redirectUri || 'https://summit-estimate.netlify.app/';
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirect)}`
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok) {
      return {
        statusCode: tokenRes.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: tokens.error || 'token_exchange_failed', detail: tokens })
      };
    }

    // Fetch the company name from QBO so we can display it in the UI
    let companyName = 'QuickBooks Company';
    try {
      const infoRes = await fetch(
        `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`,
        {
          headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Accept': 'application/json'
          }
        }
      );
      if (infoRes.ok) {
        const infoData = await infoRes.json();
        companyName = infoData?.QueryResponse?.CompanyInfo?.[0]?.CompanyName
                   || infoData?.CompanyInfo?.CompanyName
                   || companyName;
      }
    } catch (_) { /* non-fatal */ }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in:    tokens.expires_in,
        x_refresh_token_expires_in: tokens.x_refresh_token_expires_in,
        token_type:    tokens.token_type,
        realmId,
        companyName
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'server_error', message: err.message })
    };
  }
};
