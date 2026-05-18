export function calculateFutureTimestamp(hours: number, minutes: number): number {
    const now = Date.now();
    const msToAdd = (hours * 60 * 60 * 1000) + (minutes * 60 * 1000);
    return now + msToAdd;
}

export function calculateTimestampForDateTime(dateTimeInput: string): number {
    // dateTimeInput format: "YYYY-MM-DDTHH:mm" from datetime-local input
    const target = new Date(dateTimeInput);
    return target.getTime();
}

export function formatUnlockTime(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

/**
 * Fetches the current UTC time from public time APIs.
 * Tries multiple sources with a 5-second timeout each.
 * Returns epoch milliseconds, or null if all sources fail.
 */
export async function fetchNetworkTime(): Promise<number | null> {
    const sources: { url: string; parse: (data: unknown) => number }[] = [
        {
            url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
            parse: (data) => {
                const payload = data as { unixtime?: number };
                return typeof payload.unixtime === 'number' ? payload.unixtime * 1000 : 0;
            },
        },
        {
            url: 'https://timeapi.io/api/time/current/zone?timeZone=UTC',
            parse: (data) => {
                const payload = data as { dateTime?: string };
                return typeof payload.dateTime === 'string' ? new Date(`${payload.dateTime}Z`).getTime() : 0;
            },
        },
    ];

    for (const source of sources) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(source.url, {
                signal: controller.signal,
                cache: 'no-store',
            });
            clearTimeout(timeout);
            if (!res.ok) continue;
            const data = await res.json();
            const time = source.parse(data);
            if (time && !isNaN(time) && time > 0) return time;
        } catch {
            continue;
        }
    }
    return null;
}
