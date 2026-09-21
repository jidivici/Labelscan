"""Allow-listed Anthropic model capabilities used by the extraction adapter.

Model capabilities are deliberately explicit.  Guessing from a model-name prefix
can turn a harmless deployment override into a provider 400 (for example by
enabling adaptive thinking on a model that does not support it).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AnthropicModel:
    model_id: str
    cache_min_tokens: int
    max_tokens: int
    adaptive_thinking: bool
    effort: str | None
    input_usd_per_million: float
    cache_write_5m_usd_per_million: float
    cache_write_1h_usd_per_million: float
    cache_read_usd_per_million: float
    output_usd_per_million: float

    def estimated_cost_usd(
        self,
        *,
        input_tokens: int,
        output_tokens: int,
        cache_creation_tokens: int,
        cache_read_tokens: int,
        cache_ttl: str,
    ) -> float:
        """Estimate Claude API spend from provider-reported usage counters.

        Rates are kept in the same fail-closed model registry as capabilities so an
        unknown deployment override cannot silently inherit another model's price.
        """

        write_rate = (
            self.cache_write_1h_usd_per_million
            if cache_ttl == "1h"
            else self.cache_write_5m_usd_per_million
        )
        return round(
            (
                input_tokens * self.input_usd_per_million
                + output_tokens * self.output_usd_per_million
                + cache_creation_tokens * write_rate
                + cache_read_tokens * self.cache_read_usd_per_million
            )
            / 1_000_000,
            8,
        )


# USD/MTok rates verified 2026-08-31 against Anthropic's canonical prompt-caching
# pricing table. Treat any model rotation as a capability *and* pricing change:
# https://platform.claude.com/docs/en/build-with-claude/prompt-caching
_MODELS = {
    "claude-haiku-4-5": AnthropicModel(
        model_id="claude-haiku-4-5",
        cache_min_tokens=4096,
        max_tokens=4096,
        adaptive_thinking=False,
        effort=None,
        input_usd_per_million=1.0,
        cache_write_5m_usd_per_million=1.25,
        cache_write_1h_usd_per_million=2.0,
        cache_read_usd_per_million=0.10,
        output_usd_per_million=5.0,
    ),
    "claude-opus-4-8": AnthropicModel(
        model_id="claude-opus-4-8",
        cache_min_tokens=1024,
        max_tokens=8192,
        adaptive_thinking=True,
        effort="high",
        input_usd_per_million=5.0,
        cache_write_5m_usd_per_million=6.25,
        cache_write_1h_usd_per_million=10.0,
        cache_read_usd_per_million=0.50,
        output_usd_per_million=25.0,
    ),
}


def anthropic_model(model_id: str) -> AnthropicModel:
    """Return a known capability set or fail closed before making an API call."""

    try:
        return _MODELS[model_id]
    except KeyError as exc:
        allowed = ", ".join(sorted(_MODELS))
        raise ValueError(
            f"unsupported Anthropic model {model_id!r}; allowed models: {allowed}"
        ) from exc


def allowed_anthropic_models() -> tuple[str, ...]:
    return tuple(sorted(_MODELS))
