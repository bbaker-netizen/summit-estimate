// netlify/functions/qbo-refresh.js
// Refreshes a QBO access token using a refresh token.
// Called automatically by the app when the access token expires.

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

  const { refreshToken, realmId } = body;
  if (!refreshToken) {
    return { statusCode: 400, body: 'Missing refreshToken' };
  }

  const clientId     = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { statusCode: 500, body: 'QBO credentials not configured' };
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });

    const tokens = await tokenRes.json();

    if (!tokenRes.ok) {
      return {
        statusCode: tokenRes.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: tokens.error || 'refresh_failed', detail: tokens })
      };
    }

    // Optionally fetch company name if realmId provided
    let companyName = '';
    if (realmId) {
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
                     || '';
        }
      } catch (_) { /* non-fatal */ }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in:    tokens.expires_in,
        x_refresh_token_expires_in: tokens.x_refresh_token_expires_in,
        token_type:    tokens.token_type,
        realmId:       realmId || '',
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
