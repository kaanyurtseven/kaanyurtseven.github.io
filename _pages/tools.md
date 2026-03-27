---
layout: default
title: Decision Support Tools
permalink: /tools/
description: >
  Interactive tools and open-source implementations by Kaan Yurtseven for stochastic power
  system optimization, uncertainty quantification, and risk-aware decision support.
---

<main class="site-main" id="main-content">
  <div class="container container--narrow">

    <header class="page-header">
      <h1 class="page-header__title">Decision Support Tools</h1>
      <p class="page-header__subtitle">
        Tools and implementations that make uncertainty visible and usable in power system decision-making.
      </p>
    </header>

    <div class="prose">
      <p>
        This page presents tools and open-source implementations developed as part of my research
        on decision-making under uncertainty in power systems. The work spans interactive
        demonstrations of how uncertainty behaves in real systems, and research implementations
        that translate stochastic optimization methods into reproducible, operationally relevant code.
      </p>
      <p>
        A common thread across these tools is interpretability: making it possible to understand
        not only what the optimal decision is, but how uncertainty shapes it and what the associated
        risk exposure looks like.
      </p>
    </div>

    <!-- Interactive Tools -->
    <div style="margin-top: 3rem;">
      <p class="divider-label">Interactive demonstration</p>

      <div class="project-card">
        <div class="project-card__header">
          <span class="project-card__name">Forecast Error Uncertainty Explorer</span>
          <span class="project-card__status">live</span>
        </div>
        <p class="project-card__desc">
          An interactive tool that reconstructs empirical forecast error distributions from
          three years of Belgian wind and solar data. Users can condition on any forecast
          value and observe how the shape of uncertainty changes — including the departure
          from Gaussian behavior near capacity bounds and under specific forecast regimes.
          The tool fits Beta and Gaussian approximations client-side and computes CVaR
          directly from conditioned samples, illustrating the risk implications of forecast
          uncertainty in a real operational context.
        </p>
        <div class="project-card__links">
          <a href="{{ '/#forecast-explorer' | relative_url }}" class="btn btn--secondary btn--icon">Open tool</a>
        </div>
      </div>
    </div>

    <!-- Research Implementations -->
    <div style="margin-top: 3rem;">
      <p class="divider-label">Research implementations</p>

      <div class="prose" style="margin-bottom: 1.5rem;">
        <p style="font-size: var(--text-sm); color: var(--text-muted);">
          Open-source implementations of stochastic optimization formulations developed in my
          research. These accompany published work and are intended to support reproducibility
          and further development by the research community.
        </p>
      </div>

      {% assign has_projects = false %}
      {% for project in site.data.projects %}
        {% if project.featured and project.name != "your-repo-name" %}
          {% assign has_projects = true %}
        {% endif %}
      {% endfor %}

      {% if has_projects %}
        {% for project in site.data.projects %}
        {% if project.featured and project.name != "your-repo-name" %}
        <div class="project-card">
          <div class="project-card__header">
            <span class="project-card__name">{{ project.name }}</span>
            <span class="project-card__status">{{ project.status }}</span>
          </div>
          <p class="project-card__desc">{{ project.description }}</p>
          <div class="project-card__links">
            {% if project.url %}
            <a href="{{ project.url }}" target="_blank" rel="noopener noreferrer" class="btn btn--secondary btn--icon">GitHub</a>
            {% endif %}
            {% if project.language %}
            <span class="text-xs text-mono text-muted">{{ project.language }}</span>
            {% endif %}
          </div>
        </div>
        {% endif %}
        {% endfor %}
      {% else %}
        <p style="font-size: var(--text-sm); color: var(--text-muted); font-style: italic;">
          Research repositories are being prepared for public release.
        </p>
      {% endif %}
    </div>

    <div style="margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border);">
      <p class="text-muted" style="font-size: var(--text-sm);">
        Additional repositories are available on
        <a href="https://github.com/kaanyurtseven" target="_blank" rel="noopener noreferrer">GitHub</a>.
        If you are working on related problems or interested in applying these methods in practice,
        I would be glad to <a href="{{ '/contact/' | relative_url }}">discuss potential collaboration</a>.
      </p>
    </div>

  </div>
</main>
