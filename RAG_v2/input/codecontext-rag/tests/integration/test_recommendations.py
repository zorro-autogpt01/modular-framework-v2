from fastapi.testclient import TestClient
from src.codecontext.main import app

client = TestClient(app)


def test_recommendations_basic():
    # Create a repo first
    r = client.post("/repositories", json={"name": "proj", "source_type": "local"})
    assert r.status_code == 201
    repo_id = r.json()["data"]["id"]

    # Ask for recommendations
    body = {
        "repository_id": repo_id,
        "query": "implement user authentication with email and password",
        "max_results": 2,
    }
    r = client.post("/recommendations", json=body)
    assert r.status_code == 200
    data = r.json()["data"]
    assert "session_id" in data
    assert len(data["recommendations"]) >= 1
    assert data["recommendations"][0]["confidence"] >= 0
