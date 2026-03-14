let LS2Request = null;

const loadLS2Request = async () => {
	if (LS2Request) return LS2Request;
	try {
		const webos = await import('@enact/webos/LS2Request');
		LS2Request = webos.default;
		return LS2Request;
	} catch (e) {
		return null;
	}
};

const DB_KIND = 'org.moonfin.webos:1';
const DB_SERVICES = [
	'luna://com.webos.service.db',
	'luna://com.palm.db'
];
const LS_PREFIX = 'moonfin_';
const LS2_TIMEOUT_MS = 5000;

let storageInitialized = false;
let useLocalStorage = false;
let dbServiceUri = null;
let initResolve = null;
let initPromise = null;

const waitForInit = () => {
	if (storageInitialized) return Promise.resolve();
	if (!initPromise) {
		initPromise = new Promise((resolve) => { initResolve = resolve; });
	}
	return initPromise;
};

const localStorageGet = (key) => {
	try {
		const item = localStorage.getItem(LS_PREFIX + key);
		return item ? JSON.parse(item) : null;
	} catch (e) { return null; }
};

const localStorageSave = (key, value) => {
	try {
		localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
		return true;
	} catch (e) { return false; }
};

const localStorageRemove = (key) => {
	try {
		localStorage.removeItem(LS_PREFIX + key);
		return true;
	} catch (e) { return false; }
};

// Wraps an LS2Request call with a timeout so the app never hangs if the DB8
// service is unresponsive (e.g. after abnormal termination on webOS 5).
const ls2WithTimeout = (LS2, options, timeoutMs) => {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (val) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(val);
			}
		};
		const timer = setTimeout(() => {
			console.warn('[storage] LS2 timeout (' + timeoutMs + 'ms): ' + options.method);
			settle(options.fallback);
		}, timeoutMs);
		try {
			new LS2().send({
				service: options.service,
				method: options.method,
				parameters: options.parameters,
				onSuccess: (res) => settle(options.onSuccess ? options.onSuccess(res) : res),
				onFailure: (err) => {
					if (options.onFailure) {
						settle(options.onFailure(err));
					} else {
						settle(options.fallback);
					}
				}
			});
		} catch (e) { settle(options.fallback); }
	});
};

export const initStorage = async () => {
	if (storageInitialized) return true;

	const LS2 = await loadLS2Request();
	if (!LS2) {
		useLocalStorage = true;
		storageInitialized = true;
		if (initResolve) initResolve();
		console.log('[storage] LS2Request unavailable, using localStorage');
		return true;
	}

	for (let i = 0; i < DB_SERVICES.length; i++) {
		const ok = await ls2WithTimeout(LS2, {
			service: DB_SERVICES[i],
			method: 'putKind',
			parameters: {
				id: DB_KIND,
				owner: 'org.moonfin.webos',
				indexes: [{name: 'key', props: [{name: 'key'}]}]
			},
			onSuccess: () => {
				console.log('[storage] DB8 initialized via ' + DB_SERVICES[i]);
				return true;
			},
			onFailure: (err) => {
				console.warn('[storage] DB8 putKind denied at ' + DB_SERVICES[i], err);
				return false;
			},
			fallback: false
		}, LS2_TIMEOUT_MS);

		if (ok) {
			dbServiceUri = DB_SERVICES[i];
			storageInitialized = true;
			if (initResolve) initResolve();
			return true;
		}
	}

	console.warn('[storage] All DB8 endpoints failed, using localStorage');
	useLocalStorage = true;
	storageInitialized = true;
	if (initResolve) initResolve();
	return true;
};

export const getFromStorage = async (key) => {
	await waitForInit();
	const LS2 = await loadLS2Request();

	if (!LS2 || useLocalStorage) {
		return localStorageGet(key);
	}

	return ls2WithTimeout(LS2, {
		service: dbServiceUri,
		method: 'find',
		parameters: {
			query: {
				from: DB_KIND,
				where: [{prop: 'key', op: '=', val: key}]
			}
		},
		onSuccess: (res) => {
			if (res.results && res.results.length > 0) {
				return res.results[0].value;
			}
			return null;
		},
		fallback: localStorageGet(key)
	}, LS2_TIMEOUT_MS);
};

export const saveToStorage = async (key, value) => {
	await waitForInit();
	const LS2 = await loadLS2Request();

	if (!LS2 || useLocalStorage) {
		return localStorageSave(key, value);
	}

	await ls2WithTimeout(LS2, {
		service: dbServiceUri,
		method: 'del',
		parameters: {
			query: {
				from: DB_KIND,
				where: [{prop: 'key', op: '=', val: key}]
			}
		},
		onSuccess: () => true,
		fallback: false
	}, LS2_TIMEOUT_MS);

	const result = await ls2WithTimeout(LS2, {
		service: dbServiceUri,
		method: 'put',
		parameters: {
			objects: [{
				_kind: DB_KIND,
				key: key,
				value: value
			}]
		},
		onSuccess: () => true,
		fallback: localStorageSave(key, value)
	}, LS2_TIMEOUT_MS);

	localStorageSave(key, value);
	return result;
};

export const removeFromStorage = async (key) => {
	await waitForInit();
	const LS2 = await loadLS2Request();

	if (!LS2 || useLocalStorage) {
		return localStorageRemove(key);
	}

	const result = await ls2WithTimeout(LS2, {
		service: dbServiceUri,
		method: 'del',
		parameters: {
			query: {
				from: DB_KIND,
				where: [{prop: 'key', op: '=', val: key}]
			}
		},
		onSuccess: () => true,
		fallback: localStorageRemove(key)
	}, LS2_TIMEOUT_MS);

	localStorageRemove(key);
	return result;
};
