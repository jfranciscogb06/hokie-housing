"""Resolve explicit undergrad statements before the portal's audience tags."""
import re

UNDERGRAD = r"undergrad(?:uate)?s?(?: students?)?"
DENIED = re.compile(rf"\b(?:no\s+{UNDERGRAD}(?!\s+(?:restrictions?|limitations?))|{UNDERGRAD}\s+(?:are\s+)?(?:not|never)\s+(?:permitted|allowed|accepted|eligible|welcome)|not\s+(?:open|available)\s+to\s+{UNDERGRAD}|{UNDERGRAD}\s+(?:are\s+)?prohibited)\b", re.I)
GRAD_ONLY = re.compile(r"(?<!not )\b(?:grad(?:uate)?\s*(?:students?)?(?:\s*(?:and|or|/)\s*(?:faculty(?:/staff)?|staff))?\s+only|only\s+(?:for\s+)?grad(?:uate)?\s*(?:students?)?(?:\s*(?:and|or|/)\s*(?:faculty|staff))?|faculty(?:\s*(?:and|or|/)\s*staff)?\s+only)\b", re.I)
WELCOMED = re.compile(rf"\b(?:{UNDERGRAD}[-\s]+friendly|(?:open\s+to|accepts?|welcomes?)\s+{UNDERGRAD}|{UNDERGRAD}\s+(?:are\s+)?(?:allowed|permitted|welcome|accepted|eligible))\b", re.I)


def resolve_audience(description, audience):
    text = re.sub(r"\s+", " ", description or "")
    restriction = DENIED.search(text) or GRAD_ONLY.search(text)
    positive = WELCOMED.search(text)
    if not restriction and not positive:
        return audience, None
    result = dict(audience or {"undergrad": None, "grad": None, "faculty": None})
    result["undergrad"] = not bool(restriction)
    return result, {
        "source": "description", "text": (restriction or positive).group(0),
        "conflict": bool(restriction and ((audience or {}).get("undergrad") is True or positive)),
    }
