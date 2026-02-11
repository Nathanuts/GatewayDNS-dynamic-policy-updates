/**
 * SIA rDNS Worker — Multi-Aircraft Fleet Tracker
 *
 * Tracks SIA aircraft positions via Flightradar24, determines region via
 * OpenCage reverse geocoding, and updates Cloudflare Gateway Lists to
 * move each aircraft's dedicated resolver IP into the correct region list.
 *
 * Architecture:
 *   Cron (1 min) → FR24 API (get lat/lon per aircraft)
 *                → OpenCage (reverse geocode → country)
 *                → determineRegion (country → region)
 *                → Gateway Lists API (move resolver IP between region lists)
 *
 * KV keys:
 *   region:{registration}  — last known region + metadata per aircraft
 *   fleet:config           — aircraft fleet config (registration → resolver IP)
 *   lists:config           — region → Gateway List ID mapping
 */

const FLEET = [
	{ registration: '9V-SGC', resolver_ip: '183.0.1.100' },
	// { registration: '9V-SGB', resolver_ip: '10.0.1.2' },
	// { registration: '9V-SGC', resolver_ip: '10.0.1.3' },
];

const REGION_LIST_IDS = {
	SEA: '7e9f7689-ae29-4b61-b84f-419a63a5fbe4', // Southeast Asia
	NEA: '6db19c72-4672-4603-9db9-761e05798b76', // Northeast Asia
	SA:  '4d18bbe7-a7f1-4a35-a591-5506f77d8678', // South Asia
	OCE: '88be7923-a2fa-4427-8e65-f74e0c84d437', // Oceania
	ME:  'REPLACE_WITH_ME_LIST_ID', // Middle East
	EU:  'ee22b873-98a4-477e-aa4e-1a91d3c17449', // Europe
	AF:  'REPLACE_WITH_AF_LIST_ID', // Africa
	NA:  '436b0564-5f93-4db1-9d7e-89d175aa4c00', // North America
	LATAM: 'REPLACE_WITH_LATAM_LIST_ID', // Latin America
};

const REGION_NAMES = {
	SEA: 'SIA-rDNS-SEA',
	NEA: 'SIA-rDNS-NEA',
	SA:  'SIA-rDNS-SA',
	OCE: 'SIA-rDNS-OCE',
	ME:  'SIA-rDNS-ME',
	EU:  'SIA-rDNS-EU',
	AF:  'SIA-rDNS-AF',
	NA:  'SIA-rDNS-NA',
	LATAM: 'SIA-rDNS-LATAM',
};

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		
		if (url.pathname === '/track') {
			const registration = url.searchParams.get('registration');
			
			if (!registration) {
				return new Response(JSON.stringify({ error: 'Please provide registration parameter' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			
			const aircraft = FLEET.find(a => a.registration === registration);
			const location = await getAircraftLocation(registration, env.FR24_API_KEY);
			
			if (location.found && location.lat != null && location.lon != null) {
				const geo = await reverseGeocode(location.lat, location.lon, env.OPENCAGE_API_KEY);
				const region = determineRegion(geo.country_code);
				location.geo = geo;
				location.region = region;
				location.resolver_ip = aircraft?.resolver_ip || null;
			}
			
			return new Response(JSON.stringify(location), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		if (url.pathname === '/state') {
			const registration = url.searchParams.get('registration');
			if (registration) {
				const state = await env.AIRCRAFT_STATE.get(`region:${registration}`, 'json');
				return new Response(JSON.stringify(state || { message: 'No state found' }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const allStates = [];
			for (const aircraft of FLEET) {
				const state = await env.AIRCRAFT_STATE.get(`region:${aircraft.registration}`, 'json');
				if (state) allStates.push(state);
			}
			return new Response(JSON.stringify(allStates), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		if (url.pathname === '/fleet') {
			return new Response(JSON.stringify(FLEET), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		if (url.pathname === '/clear-state') {
			const registration = url.searchParams.get('registration');
			if (registration) {
				await env.AIRCRAFT_STATE.delete(`region:${registration}`);
				return new Response(JSON.stringify({ cleared: registration }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			for (const aircraft of FLEET) {
				await env.AIRCRAFT_STATE.delete(`region:${aircraft.registration}`);
			}
			return new Response(JSON.stringify({ cleared: 'all' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		return new Response(JSON.stringify({
			endpoints: [
				'GET /track?registration=9V-SJE — track single aircraft',
				'GET /state — view all aircraft states',
				'GET /state?registration=9V-SJE — view single aircraft state',
				'GET /fleet — view fleet config',
				'GET /clear-state — clear all KV state',
				'GET /clear-state?registration=9V-SJE — clear single aircraft state',
			]
		}), { headers: { 'Content-Type': 'application/json' } });
	},

	async scheduled(event, env, ctx) {
		const apiKey = env.FR24_API_KEY;
		const opencageKey = env.OPENCAGE_API_KEY;
		const cronLabel = event.cron || 'manual';
		
		if (!apiKey) {
			console.log('No FR24_API_KEY configured');
			return;
		}
		if (!opencageKey) {
			console.log('No OPENCAGE_API_KEY configured');
			return;
		}
		
		console.log(`[${cronLabel}] Processing ${FLEET.length} aircraft...`);
		
		for (const aircraft of FLEET) {
			try {
				await processAircraft(aircraft, apiKey, opencageKey, env, cronLabel);
			} catch (error) {
				console.error(`[${cronLabel}] ${aircraft.registration}: Failed — ${error.message}`);
			}
		}
	},
};

async function processAircraft(aircraft, apiKey, opencageKey, env, cronLabel) {
	const { registration, resolver_ip } = aircraft;
	
	const location = await getAircraftLocation(registration, apiKey);
	
	if (location.error || !location.found) {
		console.log(`[${cronLabel}] ${registration}: Not flying or error`);
		return;
	}
	
	const geo = await reverseGeocode(location.lat, location.lon, opencageKey);
	const currentRegion = determineRegion(geo.country_code);
	
	const stateKey = `region:${registration}`;
	const previousState = await env.AIRCRAFT_STATE.get(stateKey, 'json');
	const previousRegion = previousState?.region || null;
	
	if (currentRegion === 'OW' && previousRegion) {
		console.log(`[${cronLabel}] ${registration}: Over water (${geo.body_of_water || 'unknown'}), keeping region: ${previousRegion}`);
		
		await env.AIRCRAFT_STATE.put(stateKey, JSON.stringify({
			registration,
			resolver_ip,
			region: previousRegion,
			over_water: true,
			body_of_water: geo.body_of_water,
			lat: location.lat,
			lon: location.lon,
			callsign: location.callsign,
			updated_at: new Date().toISOString()
		}));
		return;
	}
	
	const isFirstSeen = previousRegion === null;
	const regionChanged = !isFirstSeen && previousRegion !== currentRegion;
	
	await env.AIRCRAFT_STATE.put(stateKey, JSON.stringify({
		registration,
		resolver_ip,
		region: currentRegion,
		over_water: false,
		country: geo.country,
		country_code: geo.country_code,
		lat: location.lat,
		lon: location.lon,
		callsign: location.callsign,
		updated_at: new Date().toISOString()
	}));
	
	if (isFirstSeen) {
		console.log(`[${cronLabel}] ${registration}: FIRST SEEN in ${currentRegion} (${geo.country}) | IP: ${resolver_ip}`);
		
		await updateGatewayLists(
			resolver_ip,
			null,
			currentRegion,
			env.CF_ACCOUNT_ID,
			env.CF_API_TOKEN,
			cronLabel,
			registration
		);
	} else if (regionChanged) {
		console.log(`[${cronLabel}] ${registration}: REGION CHANGED ${previousRegion} → ${currentRegion} (${geo.country}) | IP: ${resolver_ip}`);
		
		await updateGatewayLists(
			resolver_ip,
			previousRegion,
			currentRegion,
			env.CF_ACCOUNT_ID,
			env.CF_API_TOKEN,
			cronLabel,
			registration
		);
	} else {
		console.log(`[${cronLabel}] ${registration}: ${currentRegion} | ${geo.country || geo.body_of_water} | ${location.lat}, ${location.lon}`);
	}
}

async function updateGatewayLists(resolverIp, oldRegion, newRegion, accountId, apiToken, cronLabel, registration) {
	if (!accountId || !apiToken) {
		console.log(`[${cronLabel}] ${registration}: Skipping Gateway List update — missing CF_ACCOUNT_ID or CF_API_TOKEN`);
		return;
	}
	
	const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists`;
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${apiToken}`
	};
	
	if (oldRegion && oldRegion !== 'OW' && REGION_LIST_IDS[oldRegion]) {
		const listId = REGION_LIST_IDS[oldRegion];
		const removeBody = { name: REGION_NAMES[oldRegion], remove: [resolverIp] };
		console.log(`[${cronLabel}] ${registration}: [DEBUG] PATCH ${baseUrl}/${listId}`, JSON.stringify(removeBody));
		try {
			const res = await fetch(`${baseUrl}/${listId}`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify(removeBody)
			});
			const data = await res.json();
			console.log(`[${cronLabel}] ${registration}: [DEBUG] Remove response (${res.status}):`, JSON.stringify(data));
			if (data.success) {
				console.log(`[${cronLabel}] ${registration}: Removed ${resolverIp} from ${oldRegion} list`);
			} else {
				console.error(`[${cronLabel}] ${registration}: Failed to remove from ${oldRegion}:`, JSON.stringify(data.errors));
			}
		} catch (error) {
			console.error(`[${cronLabel}] ${registration}: Error removing from ${oldRegion}:`, error.message);
		}
	}
	
	if (newRegion && newRegion !== 'OW' && REGION_LIST_IDS[newRegion]) {
		const listId = REGION_LIST_IDS[newRegion];
		const appendBody = { name: REGION_NAMES[newRegion], append: [{ value: resolverIp }] };
		console.log(`[${cronLabel}] ${registration}: [DEBUG] PATCH ${baseUrl}/${listId}`, JSON.stringify(appendBody));
		try {
			const res = await fetch(`${baseUrl}/${listId}`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify(appendBody)
			});
			const data = await res.json();
			console.log(`[${cronLabel}] ${registration}: [DEBUG] Append response (${res.status}):`, JSON.stringify(data));
			if (data.success) {
				console.log(`[${cronLabel}] ${registration}: Added ${resolverIp} to ${newRegion} list`);
			} else {
				console.error(`[${cronLabel}] ${registration}: Failed to add to ${newRegion}:`, JSON.stringify(data.errors));
			}
		} catch (error) {
			console.error(`[${cronLabel}] ${registration}: Error adding to ${newRegion}:`, error.message);
		}
	}
}

async function getAircraftLocation(registration, apiKey) {
	try {
		const apiUrl = `https://fr24api.flightradar24.com/api/live/flight-positions/light?registrations=${encodeURIComponent(registration)}`;
		
		const response = await fetch(apiUrl, {
			headers: {
				'Accept': 'application/json',
				'Accept-Version': 'v1',
				'Authorization': `Bearer ${apiKey}`
			}
		});
		
		if (!response.ok) {
			return { error: `FR24 API status ${response.status}`, found: false };
		}
		
		const data = await response.json();
		
		if (!data.data || data.data.length === 0) {
			return { error: `${registration} not found or not flying`, found: false };
		}
		
		const flight = data.data[0];
		
		return {
			found: true,
			registration,
			callsign: flight.callsign,
			lat: flight.lat,
			lon: flight.lon,
			alt: flight.alt,
			gspeed: flight.gspeed,
			track: flight.track,
			timestamp: flight.timestamp
		};
		
	} catch (error) {
		return { error: error.message, found: false };
	}
}

async function reverseGeocode(lat, lon, apiKey) {
	try {
		const url = `https://api.opencagedata.com/geocode/v1/json?q=${lat},${lon}&key=${apiKey}&no_annotations=1&language=en`;
		
		const response = await fetch(url);
		
		if (!response.ok) {
			return { country: null, country_code: null, body_of_water: null };
		}
		
		const data = await response.json();
		
		if (data.results && data.results.length > 0) {
			const components = data.results[0].components;
			
			return {
				country: components.country || null,
				country_code: components.country_code?.toUpperCase() || null,
				body_of_water: components.body_of_water || null
			};
		}
		
		return { country: null, country_code: null, body_of_water: null };
		
	} catch (error) {
		console.error('Reverse geocoding error:', error.message);
		return { country: null, country_code: null, body_of_water: null };
	}
}

const COUNTRY_TO_REGION = {
	// SEA - Southeast Asia
	SG: 'SEA', MY: 'SEA', TH: 'SEA', VN: 'SEA', PH: 'SEA',
	ID: 'SEA', MM: 'SEA', KH: 'SEA', LA: 'SEA', BN: 'SEA', TL: 'SEA',
	// NEA - Northeast Asia
	JP: 'NEA', KR: 'NEA', CN: 'NEA', TW: 'NEA', HK: 'NEA', MO: 'NEA', MN: 'NEA',
	// SA - South Asia
	IN: 'SA', LK: 'SA', BD: 'SA', PK: 'SA', MV: 'SA', NP: 'SA', BT: 'SA', AF: 'SA',
	// OCE - Oceania
	AU: 'OCE', NZ: 'OCE', PG: 'OCE', FJ: 'OCE', WS: 'OCE', TO: 'OCE',
	VU: 'OCE', SB: 'OCE', NC: 'OCE', PF: 'OCE', GU: 'OCE', MP: 'OCE',
	PW: 'OCE', FM: 'OCE', MH: 'OCE',
	// ME - Middle East
	AE: 'ME', QA: 'ME', SA: 'ME', OM: 'ME', BH: 'ME', KW: 'ME',
	IQ: 'ME', IR: 'ME', JO: 'ME', LB: 'ME', IL: 'ME', PS: 'ME', YE: 'ME',
	// EU - Europe
	GB: 'EU', FR: 'EU', DE: 'EU', IT: 'EU', ES: 'EU', PT: 'EU',
	NL: 'EU', BE: 'EU', CH: 'EU', AT: 'EU', SE: 'EU', NO: 'EU',
	DK: 'EU', FI: 'EU', IE: 'EU', PL: 'EU', CZ: 'EU', GR: 'EU',
	HU: 'EU', RO: 'EU', BG: 'EU', HR: 'EU', SK: 'EU', SI: 'EU',
	LT: 'EU', LV: 'EU', EE: 'EU', LU: 'EU', MT: 'EU', CY: 'EU',
	IS: 'EU', RS: 'EU', BA: 'EU', ME: 'EU', MK: 'EU', AL: 'EU',
	UA: 'EU', MD: 'EU', BY: 'EU',
	TR: 'EU',
	RU: 'EU',
	// AF - Africa
	ZA: 'AF', KE: 'AF', EG: 'AF', NG: 'AF', ET: 'AF', TZ: 'AF',
	GH: 'AF', MA: 'AF', TN: 'AF', DZ: 'AF', SN: 'AF', CI: 'AF',
	MU: 'AF', MG: 'AF', MZ: 'AF', AO: 'AF', CM: 'AF', UG: 'AF',
	RW: 'AF', ZW: 'AF', BW: 'AF', NA: 'AF', LY: 'AF', SD: 'AF',
	// NA - North America
	US: 'NA', CA: 'NA', MX: 'NA', CU: 'NA', JM: 'NA', HT: 'NA',
	DO: 'NA', PR: 'NA', TT: 'NA', BS: 'NA', BB: 'NA', PA: 'NA',
	CR: 'NA', GT: 'NA', HN: 'NA', SV: 'NA', NI: 'NA', BZ: 'NA',
	// LATAM - South America
	BR: 'LATAM', AR: 'LATAM', CL: 'LATAM', CO: 'LATAM', PE: 'LATAM',
	EC: 'LATAM', VE: 'LATAM', BO: 'LATAM', PY: 'LATAM', UY: 'LATAM',
	GY: 'LATAM', SR: 'LATAM',
};

function determineRegion(countryCode) {
	if (countryCode && COUNTRY_TO_REGION[countryCode]) {
		return COUNTRY_TO_REGION[countryCode];
	}
	return 'OW';
}
