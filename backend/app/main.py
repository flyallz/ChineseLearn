"""P0 application entry point. Learning event endpoints begin in V0.0."""

from fastapi import FastAPI

app = FastAPI(title="汉语起步 API", version="0.0.0")


@app.get("/api/health")
def health() -> dict[str, str]:
    """A database-independent check that the API process is running."""
    return {"status": "ok", "phase": "P0"}
