from fastapi.testclient import TestClient
from src.codecontext.main import app

client = TestClient(app)


def test_repository_register_list_get_delete():
    # register
    body = {"name": "my-python-project", "source_type": "local", "source_path": "/tmp/project"}
    r = client.post("/repositories", json=body)
    assert r.status_code == 201
    repo = r.json()["data"]
    repo_id = repo["id"]

    # list
    r = client.get("/repositories")
    assert r.status_code == 201
    repos = r.json()["data"]["repositories"]
    assert any(rp["id"] == repo_id for rp in repos)

    # get
    r = client.get(f"/repositories/{repo_id}")
    assert r.status_code == 201

    # delete
    r = client.delete(f"/repositories/{repo_id}")
    assert r.status_code == 204
