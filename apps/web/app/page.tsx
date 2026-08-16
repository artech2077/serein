export default function HomePage() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <main className="foundation" id="main-content">
        <div>
          <p className="eyebrow">Serein foundations</p>
          <h1>Calm, exact, and accessible by default.</h1>
        </div>
        <p className="lede">
          The shared token system keeps financial facts, forecasts, and recovery actions legible in
          both light and dark themes.
        </p>

        <section aria-labelledby="control-states">
          <p className="eyebrow">Control states</p>
          <h2 id="control-states">Actions remain clear at every state.</h2>
          <div className="state-grid">
            <article className="state-card">
              <h3>Ready</h3>
              <p>Use a named action. Keyboard focus receives a 3 px visible ring.</p>
              <button className="button" type="button">
                Review plan
              </button>
            </article>
            <article className="state-card">
              <h3>Disabled</h3>
              <p>Consequential actions explain their prerequisite before activation.</p>
              <button className="button" disabled type="button">
                Approve plan
              </button>
            </article>
            <article className="state-card">
              <h3>Inline error</h3>
              <label className="field" data-invalid="true">
                Monthly amount
                <input aria-describedby="amount-error" aria-invalid="true" inputMode="decimal" />
              </label>
              <p className="field-error" id="amount-error">
                Enter a positive amount before saving.
              </p>
            </article>
          </div>
        </section>

        <section aria-labelledby="status-states">
          <p className="eyebrow">Status semantics</p>
          <h2 id="status-states">Never use color alone.</h2>
          <div className="status-list" aria-label="Example financial data states">
            <span className="status" data-tone="success">
              Updated now
            </span>
            <span className="status" data-tone="warning">
              2 accounts need import
            </span>
            <span className="status" data-tone="info">
              Includes 2 Quick Adds
            </span>
            <span className="status" data-tone="danger">
              Import failed — retry
            </span>
          </div>
        </section>
      </main>
    </>
  );
}
