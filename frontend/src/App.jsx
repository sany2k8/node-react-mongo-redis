import { useEffect, useState } from "react";

async function getJSON(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

export default function App() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [networkInfo, setNetworkInfo] = useState(null);
  const [counter, setCounter] = useState(null);
  const [source, setSource] = useState("");

  const loadItems = async () => {
    const data = await getJSON("/api/items/cached");
    setSource(data.source || "");
    setItems(data.items || []);
  };

  const loadNetworkInfo = async () => {
    setNetworkInfo(await getJSON("/api/network-info"));
  };

  const bumpCounter = async () => {
    const data = await getJSON("/api/counter");
    setCounter(data);
  };

  useEffect(() => {
    loadItems();
    loadNetworkInfo();
  }, []);

  const addItem = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    await getJSON("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setName("");
    loadItems();
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Node + React + MongoDB + Redis</h1>
      <p>Single-page demo used for Docker networking experiments (bridge / host / none).</p>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Network info</h2>
        <button onClick={loadNetworkInfo}>Refresh</button>
        <pre style={{ background: "#f3f3f3", padding: "1rem", overflowX: "auto" }}>
          {JSON.stringify(networkInfo, null, 2)}
        </pre>
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Redis counter</h2>
        <button onClick={bumpCounter}>Increment</button>
        <pre style={{ background: "#f3f3f3", padding: "1rem" }}>{JSON.stringify(counter, null, 2)}</pre>
      </section>

      <section>
        <h2>Items (MongoDB, cached via Redis)</h2>
        <form onSubmit={addItem} style={{ marginBottom: "1rem" }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Item name"
            style={{ marginRight: "0.5rem" }}
          />
          <button type="submit">Add</button>
        </form>
        <p>Last read source: <strong>{source || "n/a"}</strong></p>
        <ul>
          {items.map((it) => (
            <li key={it._id}>{it.name} — {it.created_at}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
