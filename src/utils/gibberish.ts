const ALPHANUMERIC_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*+?';

export function generateGibberish(length: number): string {
    let result = '';
    const charactersLength = ALPHANUMERIC_CHARS.length;
    for (let i = 0; i < length; i++) {
        result += ALPHANUMERIC_CHARS.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}
