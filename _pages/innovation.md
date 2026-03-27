---
layout: default
title: Innovation
permalink: /innovation/
description: >
  Kaan Yurtseven's direction toward practical decision-support tools for power system
  operators, transmission planners, and balancing coordination.
---

<main class="site-main" id="main-content">
  <div class="container container--narrow">

    <header class="page-header">
      <h1 class="page-header__title">Innovation</h1>
      <p class="page-header__subtitle">
        Bringing risk-aware decision support closer to power system operation.
      </p>
    </header>

    <div class="prose">

      <p>
        The methods developed in my research are designed with operational use in mind. The goal
        is not only to model uncertainty, but to translate it into decisions that can support
        congestion management and balancing in real systems.
      </p>

      <p>
        Rather than relying on simplified assumptions, this work focuses on representing
        uncertainty realistically and quantifying how it affects operational decisions. This
        enables operators and planners to understand not only expected outcomes, but also the
        associated risks and trade-offs.
      </p>

    </div>

    <!-- Directions -->
    <div style="margin-top: 3rem;">
      <p class="divider-label">Directions of interest</p>

      <div class="innovation-direction">
        <h2 class="innovation-direction__title">Congestion management under uncertainty</h2>
        <p class="text-muted" style="font-size: var(--text-sm); line-height: 1.7; max-width: 60ch;">
          Decision-support approaches that make the risk–cost trade-off explicit, allowing
          operators to manage congestion without relying on overly conservative assumptions.
        </p>
      </div>

      <div class="innovation-direction">
        <h2 class="innovation-direction__title">Risk-aware redispatch planning</h2>
        <p class="text-muted" style="font-size: var(--text-sm); line-height: 1.7; max-width: 60ch;">
          Optimization frameworks that account for the probabilistic nature of system
          constraints, providing insight into both expected costs and the distribution
          of outcomes.
        </p>
      </div>

      <div class="innovation-direction">
        <h2 class="innovation-direction__title">Balancing risk management</h2>
        <p class="text-muted" style="font-size: var(--text-sm); line-height: 1.7; max-width: 60ch;">
          Approaches that quantify real-time balancing exposure at the planning stage, linking
          day-ahead and intraday decisions through a consistent uncertainty representation.
        </p>
      </div>

      <div class="innovation-direction">
        <h2 class="innovation-direction__title">Uncertainty-aware operational planning</h2>
        <p class="text-muted" style="font-size: var(--text-sm); line-height: 1.7; max-width: 60ch;">
          Frameworks that treat uncertainty as a continuous input, enabling richer and more
          informative decision-making compared to scenario-based approaches.
        </p>
      </div>

    </div>

    <!-- Context -->
    <div style="margin-top: 3rem; padding: 1.5rem 2rem; background: var(--surface); border: 1px solid var(--border); border-radius: 4px;">
      <p style="font-size: var(--text-xs); font-family: var(--font-mono); color: var(--accent); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 1rem;">Why this matters now</p>
      <div class="prose">
        <p style="font-size: var(--text-sm); color: var(--text-muted);">
          Power systems are undergoing a structural transition driven by increasing renewable
          penetration. This raises uncertainty in both congestion management and balancing,
          while existing decision-support tools remain largely based on simplified assumptions.
        </p>
        <p style="font-size: var(--text-sm); color: var(--text-muted);">
          The methodologies developed here aim to bridge this gap by making uncertainty directly
          usable in operational decision-making, rather than abstracting it away.
        </p>
      </div>
    </div>

    <!-- Collaboration -->
    <div class="contact-block" style="margin-top: 3rem;">
      <h2 class="contact-block__title">Collaboration and engagement</h2>
      <p class="contact-block__text">
        I welcome collaboration with transmission system operators, industry partners, and
        researchers working on congestion management, balancing coordination, and operational
        planning under uncertainty.
      </p>
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-4); margin-top: 0;">
        <a href="{{ '/contact/' | relative_url }}" class="btn btn--primary">Get in touch</a>
        <a href="{{ '/research/' | relative_url }}" class="link-arrow">View the research behind this work</a>
      </div>
    </div>

  </div>
</main>
