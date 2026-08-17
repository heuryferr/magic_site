"""Gera imagens dos swatches de paletas de cores do Magic Stat.

Cria PNGs 600x60 com a amostra de cores de cada paleta, para exibir no site.
"""
import os
import seaborn as sns
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "palettes")
os.makedirs(OUT, exist_ok=True)

GROUPS = {
    "Qualitative": ["Set1", "Set2", "Set3", "Paired", "Dark2", "Accent", "tab10", "tab20", "Pastel1", "Pastel2"],
    "Sequential": ["viridis", "plasma", "inferno", "magma", "cividis", "Blues", "Greens", "Reds", "Oranges", "Purples"],
    "Diverging": ["RdBu", "RdYlBu", "RdYlGn", "Spectral", "coolwarm", "bwr", "seismic", "PiYG", "PRGn", "BrBG", "PuOr"],
}

for group, palettes in GROUPS.items():
    fig, axes = plt.subplots(len(palettes), 1, figsize=(7, 0.5 * len(palettes)))
    fig.patch.set_facecolor("#0b0e1a")
    if len(palettes) == 1:
        axes = [axes]
    for ax, name in zip(axes, palettes):
        ax.set_xlim(0, 10)
        ax.set_ylim(0, 1)
        ax.axis("off")
        colors = sns.color_palette(name, 10)
        for i, c in enumerate(colors):
            ax.add_patch(plt.Rectangle((i, 0), 1, 1, color=c, edgecolor="#0b0e1a", linewidth=0.6))
        ax.text(-0.4, 0.5, name, ha="right", va="center", fontsize=8,
                color="#eef1ff", fontweight="bold", transform=ax.transAxes)
    fig.subplots_adjust(left=0.22, right=0.99, top=0.98, bottom=0.01, hspace=0.5)
    fig.savefig(os.path.join(OUT, group.lower() + ".png"), dpi=140, facecolor="#0b0e1a")
    plt.close(fig)
    print("gerou", group)

print("ok em", OUT)
