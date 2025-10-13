import argparse
import time
import requests


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--n", type=int, default=10)
    p.add_argument("--api-key", default=None)
    args = p.parse_args()

    headers = {}
    if args.api_key:
        headers["Authorization"] = f"Bearer {args.api_key}"

    # Ensure a repo exists
    r = requests.post(f"{args.base_url}/repositories", json={"name": "bench", "source_type": "local"}, headers=headers)
    r.raise_for_status()
    repo_id = r.json()["data"]["id"]

    latencies = []
    for _ in range(args.n):
        t0 = time.time()
        body = {"repository_id": repo_id, "query": "implement user authentication", "max_results": 5}
        rr = requests.post(f"{args.base_url}/recommendations", json=body, headers=headers)
        rr.raise_for_status()
        latencies.append((time.time() - t0) * 1000)
    print(f"Requests: {args.n}, avg: {sum(latencies)/len(latencies):.2f} ms, p95: {sorted(latencies)[int(0.95*len(latencies))-1]:.2f} ms")


if __name__ == "__main__":
    main()
