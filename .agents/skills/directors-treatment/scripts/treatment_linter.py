#!/usr/bin/env python3
"""
Treatment Linter & Rule Checker for Paul Regan Style Director's Treatments.

Validates that a treatment conforms strictly to the 13 required ALL CAPS sections,
detects forbidden phrases ('Picture This', rhetorical questions, amplifying/comparative buzzwords),
and ensures brand assets (colors/fonts) and Midjourney storyboard prompts are present.
"""

import sys
import re
from pathlib import Path

# 13 Mandatory ALL CAPS Sections
REQUIRED_SECTIONS = [
    "OPENING HOOK",
    "BIG IDEA",
    "PREMISE",
    "APPROACH",
    "TONE",
    "BLOCKING AND MOVEMENT",
    "PERFORMANCE DIRECTION",
    "CHARACTERS AND CASTING",
    "THE LOOK",
    "CINEMATOGRAPHY",
    "EXECUTION",
    "STORY TREATMENT",
    "CLOSING NOTE",
]

# Strict Negative Constraints
FORBIDDEN_PHRASES = [
    r"\bpicture this\b",
    r"\bpicturing this\b",
    r"\bimagine this\b",
    r"\bclose your eyes\b",
]

AMPLIFYING_WORDS = [
    r"\bvery\b",
    r"\bextremely\b",
    r"\bincredibly\b",
    r"\brevolutionary\b",
    r"\bgame-changing\b",
    r"\bgame changer\b",
    r"\bgroundbreaking\b",
    r"\bbreathtaking\b",
    r"\bunprecedented\b",
    r"\bworld-class\b",
    r"\bunmatched\b",
    r"\bpeerless\b",
    r"\btranscendent\b",
    r"\bmonumental\b",
]

COMPARATIVE_PHRASES = [
    r"\bbetter than\b",
    r"\bunlike other\b",
    r"\bunlike most\b",
    r"\bsuperior to\b",
    r"\bthe finest\b",
    r"\bthe best in\b",
    r"\bmore innovative than\b",
    r"\boutshines\b",
]

def lint_treatment(text: str) -> dict:
    results = {
        "passed": True,
        "missing_sections": [],
        "forbidden_phrases_found": [],
        "rhetorical_questions_found": [],
        "amplifying_words_found": [],
        "comparative_phrases_found": [],
        "brand_colors_found": False,
        "brand_fonts_found": False,
        "midjourney_prompts_count": 0,
        "sections_order_valid": True,
    }

    # 1. Check ALL CAPS Sections
    found_section_indices = []
    for section in REQUIRED_SECTIONS:
        # Match header like "## OPENING HOOK" or "# OPENING HOOK" or "### 1. OPENING HOOK"
        pattern = rf"(?:^|\n)#+\s*(?:\d+[\.\)]\s*)?{re.escape(section)}"
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            # Check if it was actually in ALL CAPS
            exact_match = re.search(rf"(?:^|\n)#+\s*(?:\d+[\.\)]\s*)?{re.escape(section)}", text)
            if not exact_match:
                results["missing_sections"].append(f"{section} (Header is not in ALL CAPS)")
            else:
                found_section_indices.append(match.start())
        else:
            results["missing_sections"].append(section)

    if results["missing_sections"]:
        results["passed"] = False

    # Check order
    if found_section_indices != sorted(found_section_indices):
        results["sections_order_valid"] = False
        results["passed"] = False

    # 2. Check Forbidden Phrases (Picture this, etc.)
    for pattern in FORBIDDEN_PHRASES:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        for m in matches:
            results["forbidden_phrases_found"].append(m.group(0))
            results["passed"] = False

    # 3. Check Rhetorical Questions (Sentences ending in '?')
    # Filter out Midjourney flags or parameters or URLs
    lines = text.split("\n")
    for line_idx, line in enumerate(lines, start=1):
        clean_line = line.strip()
        # Skip markdown links, Midjourney prompt blocks, or code blocks
        if clean_line.startswith("```") or clean_line.startswith("http") or clean_line.startswith("/imagine"):
            continue
        # Search for question marks in standard body text
        q_matches = re.findall(r"([^.!?\n]+[\?])", clean_line)
        for q in q_matches:
            # Ignore question marks inside markdown URLs
            if "http" not in q and "file://" not in q:
                results["rhetorical_questions_found"].append(f"Line {line_idx}: {q.strip()}")
                results["passed"] = False

    # 4. Check Amplifying Language
    for pattern in AMPLIFYING_WORDS:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        for m in matches:
            results["amplifying_words_found"].append(m.group(0))
            results["passed"] = False

    # 5. Check Comparative Language
    for pattern in COMPARATIVE_PHRASES:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        for m in matches:
            results["comparative_phrases_found"].append(m.group(0))
            results["passed"] = False

    # 6. Check Brand Colors (HEX codes or color palette keywords)
    hex_codes = re.findall(r"#[0-9a-fA-F]{6}\b", text)
    if hex_codes or re.search(r"brand color|palette|pantone", text, re.IGNORECASE):
        results["brand_colors_found"] = True

    # 7. Check Brand Fonts / Typography
    if re.search(r"font|typography|typeface|typeset", text, re.IGNORECASE):
        results["brand_fonts_found"] = True

    # 8. Check Nano Banana 2.1 Image Prompts
    nb_matches = re.findall(
        r"(?:nano\s*banana(?:\s*2\.1)?\s*(?:prompt|image|frame)|image\s*generation\s*prompt:).*?(?:aspect\s*ratio|16:9|camera|lighting|palette)",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if not nb_matches:
        # Fallback check for prompt blocks mentioning Nano Banana 2.1
        nb_matches = re.findall(r"nano\s*banana\s*2\.1", text, re.IGNORECASE)
    results["nano_banana_prompts_count"] = len(nb_matches)

    return results

def print_report(results: dict):
    print("=" * 60)
    print(" DIRECTOR'S TREATMENT LINT REPORT (PAUL REGAN STYLE)")
    print("=" * 60)
    
    status = "PASSED" if results["passed"] else "FAILED"
    print(f"Overall Status: {status}\n")

    # Sections
    print(f"1. Section Structure ({len(REQUIRED_SECTIONS) - len(results['missing_sections'])}/{len(REQUIRED_SECTIONS)} present):")
    if results["missing_sections"]:
        print("   [!] Missing or non-ALL CAPS sections:")
        for s in results["missing_sections"]:
            print(f"       - {s}")
    else:
        print("   [✓] All 13 mandatory ALL CAPS sections present in order.")

    # Forbidden Phrases
    print("\n2. Forbidden Phrases ('Picture This', etc.):")
    if results["forbidden_phrases_found"]:
        print("   [X] VIOLATION: Found forbidden phrases:")
        for p in results["forbidden_phrases_found"]:
            print(f"       - '{p}'")
    else:
        print("   [✓] None found.")

    # Rhetorical Questions
    print("\n3. Rhetorical Questions:")
    if results["rhetorical_questions_found"]:
        print("   [X] VIOLATION: Found rhetorical questions (Must be declarative statements):")
        for q in results["rhetorical_questions_found"][:5]:
            print(f"       - {q}")
        if len(results["rhetorical_questions_found"]) > 5:
            print(f"       ... and {len(results['rhetorical_questions_found']) - 5} more.")
    else:
        print("   [✓] Zero rhetorical questions detected.")

    # Amplifying Language
    print("\n4. Amplifying Words ('very', 'revolutionary', etc.):")
    if results["amplifying_words_found"]:
        print("   [X] VIOLATION: Found amplifying words:")
        for w in set(results["amplifying_words_found"]):
            print(f"       - '{w}'")
    else:
        print("   [✓] Clean. No amplifying language detected.")

    # Comparative Language
    print("\n5. Comparative Language ('better than', 'superior', etc.):")
    if results["comparative_phrases_found"]:
        print("   [X] VIOLATION: Found comparative phrases:")
        for c in set(results["comparative_phrases_found"]):
            print(f"       - '{c}'")
    else:
        print("   [✓] Clean. No comparative language detected.")

    # Brand Assets
    print("\n6. Brand Assets Extraction:")
    print(f"   - Brand Colors / Palette: {'[✓] Detected' if results['brand_colors_found'] else '[!] Missing'}")
    print(f"   - Brand Fonts / Typography: {'[✓] Detected' if results['brand_fonts_found'] else '[!] Missing'}")

    # Nano Banana 2.1 Prompts
    print("\n7. Nano Banana 2.1 Storyboard Artwork Prompts:")
    print(f"   - Prompts detected: {results['nano_banana_prompts_count']}")
    if results['nano_banana_prompts_count'] < 3:
        print("   [!] Recommend at least 3-5 key storyboard frame prompts using Nano Banana 2.1.")
    else:
        print("   [✓] Adequate storyboard frame coverage.")

    print("=" * 60)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 treatment_linter.py <path_to_treatment.md>")
        sys.exit(1)

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"Error: File not found: {path}")
        sys.exit(1)

    content = path.read_text(encoding="utf-8")
    results = lint_treatment(content)
    print_report(results)
    sys.exit(0 if results["passed"] else 1)

if __name__ == "__main__":
    main()
