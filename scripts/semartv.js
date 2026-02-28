const fs = require('fs');
const readline = require('readline');

const PLAYLIST_URL = "https://getch.semar.my.id/";
const USER_AGENT = "TiviMate/5.0.4"; // Required to bypass
const CLEARKEY_PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleCoreMedia/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36";

/**
 * Helper to fetch ClearKey JSON from provider and format it as kid:key
 */
async function fetchAndFormatClearKey(licenseUrl) {
    try {
        // Create a dummy payload. Most providers just need ANY kids array to respond with the full key rotation.
        const payload = { kids: ["W2uFp1vEQKigw1q1yU_9Wg"], type: "temporary" };

        let headers = {
            'Content-Type': 'application/json',
            'User-Agent': CLEARKEY_PROXY_UA
        };

        if (licenseUrl.includes('semar.my.id')) {
            try {
                const urlObj = new URL(licenseUrl);
                headers['Referer'] = urlObj.origin + '/';
                headers['Origin'] = urlObj.origin;
            } catch (e) {
                // Fallback
                headers['Referer'] = 'https://sports.semar.my.id/';
                headers['Origin'] = 'https://sports.semar.my.id';
            }
        }

        const res = await fetch(licenseUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.log(`\n  -> [Provider Error] HTTP ${res.status} ${res.statusText} on ${licenseUrl}`);
            const errText = await res.text().catch(()=>'');
            if (errText) console.log(`  -> [Provider Body] ${errText.substring(0, 150)}`);
            return licenseUrl; // Fallback to original if failed
        }

        const data = await res.json();
        
        if (data.keys && data.keys.length > 0) {
            // Helper to decode Base64Url into raw Hex string
            const base64ToHex = (base64) => {
                const b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
                const raw = atob(b64);
                let hex = '';
                for (let i = 0; i < raw.length; i++) {
                    const hexChar = raw.charCodeAt(i).toString(16);
                    hex += (hexChar.length === 2 ? hexChar : '0' + hexChar);
                }
                return hex;
            };

            const keyPairs = data.keys.map(k => {
                if (k.kty === 'oct' && k.k && k.kid) {
                    return `${base64ToHex(k.kid)}:${base64ToHex(k.k)}`;
                }
                return null;
            }).filter(Boolean);

            if (keyPairs.length > 0) {
                return keyPairs.join(','); // E.g., "kid1:key1,kid2:key2"
            }
        }
        return licenseUrl;
    } catch (e) {
        console.error(`Failed to fetch key for ${licenseUrl}:`, e.message);
        return licenseUrl;
    }
}

async function getWorkingProxy() {
    console.log(`[0/3] Fetching Indonesian proxies to bypass Datacenter Block...`);
    try {
        const proxyListUrl = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=id&ssl=all&anonymity=all';
        const res = await fetch(proxyListUrl);
        const text = await res.text();
        const proxies = text.split('\n').map(p => p.trim()).filter(Boolean);
        return proxies;
    } catch (e) {
        console.log(`Failed to fetch proxies:`, e.message);
        return [];
    }
}

async function fetchWithRetry(url, options, proxies) {
    const HttpsProxyAgent = require('https-proxy-agent');
    const fetchWithAgent = require('node-fetch');

    // Coba tanpa proxy dulu (siapa tahu lolos)
    try {
        console.log(`  -> Trying direct connection...`);
        const res = await fetch(url, options);
        let text = await res.text();
        text = text.trim();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        if (text.startsWith("#EXTM3U")) return text;
    } catch (e) {}

    // Kalau gagal, coba pakai proxy
    for (let i = 0; i < Math.min(20, proxies.length); i++) {
        const proxyUrl = `http://${proxies[i]}`;
        console.log(`  -> Trying proxy: ${proxyUrl}...`);
        
        try {
            const agent = new HttpsProxyAgent(proxyUrl);
            const proxyOptions = { ...options, agent, timeout: 5000 };
            
            const res = await fetchWithAgent(url, proxyOptions);
            if (!res.ok) continue;

            let text = await res.text();
            text = text.trim();
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

            if (text.startsWith("#EXTM3U")) {
                console.log(`  -> Success with proxy ${proxies[i]}!`);
                return text;
            }
        } catch (e) {
            // Abaikan error timeout/koneksi proxy
        }
    }
    
    throw new Error("Invalid M3U received or blocked by all proxies.");
}

async function generateOfflineM3U() {
    console.log(`[1/3] Downloading live playlist from: ${PLAYLIST_URL}`);
    
    try {
        const proxies = await getWorkingProxy();
        
        const fetchOptions = {
            headers: { 
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
                "Accept-Encoding": "gzip",
                "Connection": "Keep-Alive"
            },
            redirect: "follow"
        };

        const m3uText = await fetchWithRetry(PLAYLIST_URL, fetchOptions, proxies);

        console.log(`[2/3] Playlist downloaded. Sifting for ClearKey links and fetching keys...`);
        
        const lines = m3uText.split('\n');
        let processedLines = [];
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            // Look for ClearKey KODIPROP properties
            if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
                let licenseUrl = line.substring('#KODIPROP:inputstream.adaptive.license_key='.length).trim();
                
                // If it's a web URL containing ck.php or clearkey or pidick.php or .kt, intercept it
                if (licenseUrl && licenseUrl.startsWith('http') && (licenseUrl.includes('ck.php') || licenseUrl.includes('clearkey') || licenseUrl.includes('pidick.php') || licenseUrl.includes('.kt'))) {
                    process.stdout.write(`Fetching key for URL -> ${licenseUrl.substring(0, 50)}... `);
                    
                    const hexKeyCombo = await fetchAndFormatClearKey(licenseUrl);
                    
                    if (hexKeyCombo && hexKeyCombo !== licenseUrl) {
                        console.log(`SUCCESS`);
                        processedLines.push(`#KODIPROP:inputstream.adaptive.license_key=${hexKeyCombo}`);
                    } else {
                        console.log(`FAILED (Keeping original URL)`);
                        processedLines.push(line);
                    }
                } else {
                    processedLines.push(line);
                }
            } else {
                processedLines.push(line);
            }
        }

        const outputPath = './playlist_offline_ready.m3u';
        fs.writeFileSync(outputPath, processedLines.join('\n'));
        console.log(`\n[3/3] DONE! Offline M3U has been written to: ${outputPath}`);
        
    } catch (error) {
        console.error("Error generating offline M3U:", error);
    }
}

generateOfflineM3U();
