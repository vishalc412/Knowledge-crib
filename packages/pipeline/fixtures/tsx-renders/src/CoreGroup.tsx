import GradeBandGroup from "./GradeBandGroup";

export default function CoreGroup({bands}: {bands: string[]}) {
    return (
        <section>
            <GradeBandGroup bands={bands}/>
        </section>
    );
}

export function Shadowed() {
    const GradeBandGroup = () => null;
    return <GradeBandGroup/>;
}
