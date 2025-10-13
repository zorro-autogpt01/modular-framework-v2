import argparse
import requests


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--name", required=True)
    p.add_argument("--source-type", default="local")
    p.add_argument("--source-path", default=None)
    p.add_argument("--mode", default="incremental", choices=["full", "incremental"])
    p.add_argument("--api-key", default=None)
    args = p.parse_args()

    headers = {}
    if args.api_key:
        headers["Authorization"] = f"Bearer {args.api_key}"

    r = requests.post(f"{args.base_url}/repositories", json={
        "name": args.name,
        "source_type": args.source_type,
        "source_path": args.source_path,
    }, headers=headers)
    r.raise_for_status()
    repo_id = r.json()["data"]["id"]
    print("Registered:", repo_id)

    r = requests.post(f"{args.base_url}/repositories/{repo_id}/index", json={"mode": args.mode}, headers=headers)
    r.raise_for_status()
    print("Index job:", r.json()["data"]) 


if __name__ == "__main__":
    main()
