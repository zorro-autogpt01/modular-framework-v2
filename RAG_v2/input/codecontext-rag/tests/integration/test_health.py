from fastapi.testclient import TestClient
from src.codecontext.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["success"] is True
    assert data["data"]["status"] in {"healthy", "degraded", "unhealthy"}
    assert "metadata" in data
