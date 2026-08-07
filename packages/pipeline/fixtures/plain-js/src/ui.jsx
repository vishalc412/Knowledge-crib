// JSX parity fixture (M2.5) — a component returning JSX. The extractor must parse this with
// ScriptKind.JSX (not TS/TSX) and surface the Greeting function symbol tagged lang:"javascript".

function Greeting(props) {
  return <div className="greeting">Hello, {props.name}</div>;
}

export default Greeting;
