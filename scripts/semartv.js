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
    let allProxies = new Set();
    
    try {
        const url1 = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=id&ssl=all&anonymity=all';
        const res1 = await fetch(url1);
        const text1 = await res1.text();
        text1.split('\n').map(p => p.trim()).filter(Boolean).forEach(p => allProxies.add(p));
    } catch (e) {}

    try {
        const url2 = 'https://www.proxy-list.download/api/v1/get?type=http&country=ID';
        const res2 = await fetch(url2);
        const text2 = await res2.text();
        text2.split('\n').map(p => p.trim()).filter(Boolean).forEach(p => allProxies.add(p));
    } catch (e) {}

    const proxyList = Array.from(allProxies);
    console.log(`  -> Found ${proxyList.length} proxies.`);
    return proxyList;
}

async function fetchWithRetry(url, options, proxies) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const fetchWithAgent = require('node-fetch');
    const { spawnSync } = require('child_process');

    // Coba menggunakan CURL (untuk bypass Cloudflare TLS Fingerprint pada Node.js)
    try {
        console.log(`  -> Trying system curl (TLS Bypass)...`);
        
        const args = [
            '-sL', url,
            '-H', `User-Agent: ${options.headers['User-Agent']}`,
            '-H', 'Accept: */*',
            '-H', 'Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            '-H', 'Connection: keep-alive',
            '--compressed'
        ];
        
        const curlResult = spawnSync('curl', args, { encoding: 'utf-8' });
        
        if (curlResult.stdout) {
            let text = curlResult.stdout.trim();
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            if (text.startsWith("#EXTM3U")) {
                console.log(`  -> Success with system curl!`);
                return text;
            }
        }
    } catch (e) {}

    // Coba tanpa proxy pakai Node Fetch
    try {
        console.log(`  -> Trying direct Node fetch...`);
        const res = await fetch(url, options);
        let text = await res.text();
        text = text.trim();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        if (text.startsWith("#EXTM3U")) return text;
    } catch (e) {}

    if (proxies.length === 0) {
        throw new Error("No proxies available to bypass Cloudflare.");
    }

    console.log(`  -> Racing ${proxies.length} proxies concurrently...`);
    
    return new Promise((resolve, reject) => {
        let pending = proxies.length;
        let resolved = false;

        const checkData = (text) => {
            text = text.trim();
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            return text.startsWith("#EXTM3U") ? text : null;
        };

        for (let i = 0; i < proxies.length; i++) {
            const proxyUrl = `http://${proxies[i]}`;
            const agent = new HttpsProxyAgent(proxyUrl);
            const proxyOptions = { ...options, agent, timeout: 15000 };

            fetchWithAgent(url, proxyOptions)
                .then(async (res) => {
                    if (resolved) return;
                    if (!res.ok) throw new Error("Status " + res.status);
                    
                    const text = await res.text();
                    const validM3u = checkData(text);
                    
                    if (validM3u) {
                        resolved = true;
                        console.log(`  -> Success with proxy ${proxies[i]}!`);
                        resolve(validM3u);
                    } else {
                        throw new Error("Not M3U format");
                    }
                })
                .catch((err) => {
                    pending--;
                    if (pending === 0 && !resolved) {
                        reject(new Error("Invalid M3U received or blocked by all proxies."));
                    }
                });
        }
    });
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

        const outputPath = 'semar.m3u8';
        fs.writeFileSync(outputPath, processedLines.join('\n'));
        console.log(`\n[3/3] DONE! Offline M3U has been written to: ${outputPath}`);
        process.exit(0);
        
    } catch (error) {
        console.error("Error generating offline M3U:", error);
        process.exit(1);
    }
}

generateOfflineM3U();
