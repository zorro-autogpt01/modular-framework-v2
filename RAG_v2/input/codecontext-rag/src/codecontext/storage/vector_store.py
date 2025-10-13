class VectorStore:
    def __init__(self, path: str) -> None:
        self.path = path

    def upsert(self, items: list[dict]) -> None:
        # TODO: Integrate LanceDB
        pass

    def search(self, embedding: list[float], k: int = 10) -> list[dict]:
        # TODO: Semantic search
        return []
