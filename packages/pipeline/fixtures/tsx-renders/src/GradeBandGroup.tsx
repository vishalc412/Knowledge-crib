export function validateGradeBands(bands: string[]): boolean {
    return bands.length > 0;
}

export default function GradeBandGroup({bands}: {bands: string[]}) {
    return <div>{validateGradeBands(bands) ? 'ok' : 'invalid'}</div>;
}
