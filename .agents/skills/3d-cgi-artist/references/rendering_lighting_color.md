# Rendering Theory, PBR Optics & Color Science

> *"Photons do not carry color; they carry energy at specific wavelengths. Color is a biological sensation, and rendering is the simulation of energy transport across matter."*

---

## 1. Physically Based Rendering (PBR) & Microfacet Theory

PBR is governed by **Energy Conservation**: a surface cannot reflect more light energy than it receives.

$$\text{Reflected Light} = \text{Diffuse Energy} (k_d) + \text{Specular Energy} (k_s) \le 1.0$$

### 1.1 The Cook-Torrance Specular BRDF
For real-time and offline CGI, specular reflectance is modeled by the Cook-Torrance equation:

$$f_{\text{specular}}(\vec{l}, \vec{v}) = \frac{D(\vec{h}) \cdot F(\vec{v}, \vec{h}) \cdot G(\vec{l}, \vec{v}, \vec{h})}{4 (\vec{n} \cdot \vec{l}) (\vec{n} \cdot \vec{v})}$$

Where $\vec{h} = \text{normalize}(\vec{l} + \vec{v})$ is the **Halfway Vector**.

#### 1. $D(\vec{h})$: Normal Distribution Function (GGX / Trowbridge-Reitz)
Determines the statistical concentration of microfacets aligned with the halfway vector:
$$D_{\text{GGX}}(\vec{h}) = \frac{\alpha^2}{\pi \left( (\vec{n} \cdot \vec{h})^2 (\alpha^2 - 1) + 1 \right)^2}$$
*(Where $\alpha = \text{Roughness}^2$). GGX produces a natural, physically grounded specular tail that matches real-world metals and plastics.*

#### 2. $F(\vec{v}, \vec{h})$: The Fresnel-Schlick Approximation
Light glancing off a surface at grazing angles ($90^\circ$) reflects at nearly $100\%$ intensity, regardless of material:
$$F(\vec{v}, \vec{h}) = F_0 + (1 - F_0)(1 - (\vec{v} \cdot \vec{h}))^5$$
- **Dielectrics (Plastics, Wood, Skin, Stone)**: $F_0 \approx 0.04$ (reflects $4\%$ at perpendicular view, $100\%$ at grazing angle).
- **Conductors (Metals: Gold, Copper, Chrome)**: $F_0$ is tinted and high ($0.7 - 0.98$). Metals have **zero diffuse reflection**; all light is reflected specularly.

#### 3. $G(\vec{l}, \vec{v}, \vec{h})$: Geometric Shadowing & Masking (Smith Model)
Accounts for microfacets occluding each other from the light ray ($G_1(\vec{l})$) or eye ray ($G_1(\vec{v})$):
$$G(\vec{l}, \vec{v}) = G_1(\vec{l}) \cdot G_1(\vec{v})$$

---

## 2. Color Spaces: Linear, ACEScg, AgX & Filmic

```
       [Raw Texture sRGB / Albedo]
                   │
                   v (Remove Gamma 2.2: pow(x, 2.2))
       [Linear Working Space (Calculations)]
        - Light addition, BRDF multiplication, GI bounces
                   │
                   v (Tone Mapping & Color Transform)
       [Display Output: AgX / ACEScg / Rec.709]
```

### 2.1 Why Linear Math is Mandatory
If you add two light sources in non-linear sRGB (gamma) space:
$$(0.5 + 0.5)^{2.2} \ne 0.5^{2.2} + 0.5^{2.2}$$
Computing shaders in gamma space causes:
- Burned-out, oversaturated neon highlight fringes.
- Unnatural, muddy dark shadow terminators.
- Completely incorrect falloff curves for point lights ($1 / d^2$).

### 2.2 Display Transforms: AgX vs Filmic vs ACEScg
- **ACEScg (AP1 Gamut)**: Film industry standard for VFX and virtual production. Exceptionally wide gamut, but requires careful gamut mapping to avoid out-of-gamut laser color artifacts.
- **Filmic (Blender legacy)**: Compresses dynamic range cleanly, but can shift hues in extreme overexposure (e.g. intense fire turning pale yellow-green).
- **AgX (Blender 4.0+ default)**: Modern state-of-the-art camera transform. Handles extreme overexposure without hue skewing (fire desaturates naturally to pure radiant white at the core, mimicking Kodak film emulsion).

---

## 3. Specular Aliasing & Toksvig Filtering

### The Problem:
When a high-frequency normal map (pebbles, brushed metal, carbon weave) recedes into the distance, a single screen pixel covers thousands of micro-normal variations. The GPU takes one single normal sample, causing sickening crawling specular shimmering and sparkling fireflies during camera movement.

### The Out-of-the-Box Fix (Toksvig / Normal Variance Filtering):
Instead of just mipmapping the normal map (which averages vectors and flattens bumps), measure the **length loss** of the averaged normal vector across mip levels:
$$\vec{N}_{\text{mip}} = \text{sample}(\text{NormalMap}, \text{UV}, \text{mipLevel})$$
$$L = \|\vec{N}_{\text{mip}}\|$$
If $L < 1.0$, microfacets are pointing in conflicting directions within that pixel! Widen the material roughness to compensate:
$$\text{Roughness}_{\text{effective}} = \sqrt{\text{Roughness}^2 + (1.0 - L) \times \text{ToksvigFactor}}$$
**Result**: Crystal-clear specular reflections with **zero crawling shimmer or flickering fireflies**, even on fine chainmail or metallic car paint at 4K.

---

## 4. Cinematic Lighting Principles for 3D CGI

1. **Motivated Lighting**: Every light in the scene must have an identifiable physical origin in the environment (sun, skylight, wall sconce, computer monitor, fireplace, streetlamp).
2. **Key-to-Fill Contrast Ratios**:
   - High-Key (Comedy, Commercial, Clean Sci-Fi): $2:1$ or $3:1$ ratio. Soft shadows, low drama.
   - Low-Key / Film Noir (Thriller, Cyberpunk, Horror): $8:1$ to $16:1$ ratio. Deep crushing blacks, sharp specular cuts.
3. **Rim / Edge Separation**: Never let a dark character silhouette merge into a dark background. Place a glancing rim light ($180^\circ$ opposite the camera) with high intensity to draw an edge along the silhouette.
4. **Atmospheric Perspective (Z-Depth Falloff)**: Contrast decreases and color shifts toward ambient fog color with distance. Objects 100 meters away must have lower contrast than foreground hero props.
