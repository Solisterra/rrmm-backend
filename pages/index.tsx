export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#000",
        color: "#fff",
        fontFamily: "Arial, sans-serif",
        textAlign: "center",
        padding: "24px",
      }}
    >
      <div>
        <h1 style={{ marginBottom: "12px" }}>Welcome to RRMM Backend</h1>
        <p style={{ margin: 0, color: "#A0A0A0" }}>
          API routes are available under <code>/api</code>.
        </p>
      </div>
    </main>
  );
}
