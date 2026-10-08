export type EngineDnsRecord = {
	type: 'A' | 'CNAME' | 'TXT';
	name: string;
	hostname: string;
	value: string;
	purpose: 'routing' | 'verification';
};

type RecommendedValue = { rank?: number; value?: string | string[] };

function values(input: unknown): string[] {
	const ordered = (Array.isArray(input) ? input : []) as RecommendedValue[];
	return ordered
		.filter((item) => item && typeof item === 'object')
		.sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999))
		.flatMap((item) => Array.isArray(item.value) ? item.value : [item.value])
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		.map((value) => value.trim());
}

function dnsName(hostname: string, apexName: string): string {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	const apex = apexName.toLowerCase().replace(/\.$/, '');
	if (!apex) return host;
	if (host === apex) return '@';
	return host.endsWith('.' + apex) ? host.slice(0, -(apex.length + 1)) : host;
}

/** Records are based on Vercel's domain-specific recommendations, never fixed DNS targets. */
export function describeEngineDomainDns(domain: string, projectDomain: any, config: any) {
	const name = domain.toLowerCase().replace(/\.$/, '');
	const apexName = String(projectDomain?.apexName || config?.apexName || '').toLowerCase().replace(/\.$/, '');
	const isApex = apexName ? name === apexName : null;
	const aRecords = values(config?.recommendedIPv4);
	const cnames = values(config?.recommendedCNAME);
	const records: EngineDnsRecord[] = [];
	const addRouting = (type: 'A' | 'CNAME', targets: string[]) => {
		for (const target of targets) records.push({type, name:dnsName(name,apexName), hostname:name, value:target, purpose:'routing'});
	};
	if (isApex === true) addRouting('A', aRecords.slice(0, 1));
	else if (isApex === false) addRouting('CNAME', cnames.slice(0, 1));
	else if (cnames.length && !aRecords.length) addRouting('CNAME', cnames.slice(0, 1));
	else if (aRecords.length && !cnames.length) addRouting('A', aRecords.slice(0, 1));

	// Ownership verification TXT is separate from the A/CNAME traffic-routing record.
	if (projectDomain?.verified !== true) {
		for (const challenge of Array.isArray(projectDomain?.verification) ? projectDomain.verification : []) {
			if (String(challenge?.type || '').toUpperCase() !== 'TXT') continue;
			const value = String(challenge?.value || '').trim();
			if (!value) continue;
			const hostname = String(challenge?.domain || name).toLowerCase().replace(/\.$/, '');
			records.push({type:'TXT', name:dnsName(hostname,apexName), hostname, value, purpose:'verification'});
		}
	}
	const ownershipVerified = projectDomain?.verified === true;
	const dnsConfigured = typeof config?.misconfigured === 'boolean' ? config.misconfigured === false : null;
	const ready = ownershipVerified && dnsConfigured === true;
	return {
		domain:name, apexName:apexName||null, isApex, records,
		ownershipVerified, dnsConfigured, ready,
		configuredBy:config?.configuredBy ?? null,
		hasRoutingRecommendation:records.some((item)=>item.purpose==='routing'),
		checkedAt:new Date().toISOString()
	};
}
