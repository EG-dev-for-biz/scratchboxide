// Vertex Shader
#define VertexShader
#ifdef VertexShader
varying vec3 vNormal;
varying vec2 vUv;
void main() {
    vNormal = normalize(normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
#endif

// Fragment Shader
#define FragmentShader
#ifdef FragmentShader
uniform vec3 uColor;
uniform float uTime;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
    float pulse = sin(uTime * 2.0) * 0.5 + 0.5;
    vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
    float diff = max(dot(vNormal, lightDir), 0.0);
    vec3 finalColor = mix(uColor, vec3(1.0, 1.0, 1.0), pulse * 0.2) * (diff + 0.1);
    gl_FragColor = vec4(finalColor, 1.0);
}
#endif
