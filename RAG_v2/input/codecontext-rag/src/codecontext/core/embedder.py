class Embedder:
    def __init__(self, model_name: str) -> None:
        self.model_name = model_name

    def embed_text(self, text: str) -> list[float]:
        # TODO: Integrate sentence-transformers or OpenAI embeddings
        return [0.0]
