from fastapi.testclient import TestClient
from src.codecontext.main import app

client = TestClient(app)


def test_search_code():
    # Create a repo for context
    r = client.post("/repositories", json={"name": "proj2", "source_type": "local"})
    assert r.status_code == 201
    repo_id = r.json()["data"]["id"]

    body = {"repository_id": repo_id, "query": "functions that validate email addresses", "search_type": "semantic", "max_results": 1}
    r = client.post("/search/code", json=body)
    assert r.status_code == 200
    payload = r.json()["data"]
    assert payload["total_results"] >= 0
