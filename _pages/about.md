---
layout: default
title: About
permalink: /about/
description: >
  Kaan Yurtseven — Ph.D. researcher at KU Leuven and EnergyVille,
  working on stochastic optimization and risk-aware decision support for power systems.
---

<main class="site-main" id="main-content">
  <div class="container">
    <div class="about-layout">

      <!-- Sidebar -->
      <aside class="about-sidebar" aria-label="Profile">
        <div class="about-sidebar__photo">
          <img src="{{ '/assets/images/kaan-yurtseven.jpg' | relative_url }}" alt="Kaan Yurtseven" width="200" height="200">
        </div>

        <p class="about-sidebar__name">Kaan Yurtseven</p>
        <p class="about-sidebar__role">
          Ph.D. Researcher<br>
          KU Leuven &amp; EnergyVille<br>
          Etch — Energy Transmission Competence Hub
        </p>

        <nav class="about-sidebar__links" aria-label="Contact links">
          <a href="mailto:kaan.yurtseven@kuleuven.be">kaan.yurtseven@kuleuven.be</a>
          <a href="https://linkedin.com/in/kaanyurtseven" target="_blank" rel="noopener noreferrer">LinkedIn</a>
          <a href="https://github.com/kaanyurtseven" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="https://scholar.google.com/citations?user=M4bo2DMAAAAJ" target="_blank" rel="noopener noreferrer">Google Scholar</a>
          <a href="{{ '/cv/' | relative_url }}">Curriculum Vitae</a>
        </nav>
      </aside>

      <!-- Main content -->
      <div class="prose">
        <header class="page-header" style="border-bottom: 1px solid var(--border); padding-bottom: 2rem; margin-bottom: 2.5rem;">
          <h1 class="page-header__title">About</h1>
        </header>

        <p>
          I am a Ph.D. researcher at KU Leuven and EnergyVille working on risk-aware decision
          support for power system operation under uncertainty.
        </p>

        <p>
          My work focuses on how uncertainty in renewable generation affects congestion management
          and balancing, and on developing methods that make this uncertainty directly usable in
          operational decision-making.
        </p>

        <h2>Research</h2>

        <p>
          Modern power systems are increasingly shaped by uncertainty from renewable generation,
          demand variability, and market behavior. This uncertainty links congestion management
          and real-time balancing decisions, although they are still often treated separately
          in practice.
        </p>

        <p>
          My research develops stochastic optimization frameworks that treat this coupling
          explicitly. The goal is to enable operators and planners to manage costs and risks
          jointly, rather than sequentially, while accounting for uncertainty in a continuous
          and realistic manner.
        </p>

        <p>
          A central methodological component is the use of Polynomial Chaos Expansion for
          non-Gaussian uncertainty propagation. This allows tractable formulations of risk-aware
          optimization problems, including CVaR-based objectives, without relying on large sets
          of discrete scenarios.
        </p>

        <h2>Approach and methodology</h2>

        <p>
          I work at the boundary between theory and application. The formulations I develop are
          mathematically rigorous, but designed from the outset to be computationally tractable
          in operational settings.
        </p>

        <p>
          A key focus is on how the structure of uncertainty — including distribution shape and
          correlations — affects decision quality and system costs. Rather than simplifying
          uncertainty, I develop methods that preserve these characteristics and make their
          impact on decisions explicit.
        </p>

        <p>
          My work also considers hybrid AC/DC grids, analyzing how HVDC controllability
          influences congestion patterns and operational flexibility.
        </p>

        <h2>Perspective</h2>

        <p>
          A central aspect of my work is not only to model uncertainty, but to quantify how
          it affects decisions.
        </p>

        <p>
          Rather than treating uncertainty as an abstract input, I focus on understanding how
          probabilistic forecasts propagate into congestion management actions, redispatch
          decisions, and balancing requirements. This provides a transparent link between
          uncertainty and operational outcomes, enabling more informed and risk-aware
          decision-making.
        </p>

        <h3>Methods and tools</h3>

        <div class="method-tags" aria-label="Research methods and topics">
          <span class="method-tag">Polynomial Chaos Expansion</span>
          <span class="method-tag">Stochastic optimal power flow</span>
          <span class="method-tag">CVaR / risk measures</span>
          <span class="method-tag">Non-Gaussian uncertainty</span>
          <span class="method-tag">Chance-constrained optimization</span>
          <span class="method-tag">Congestion management</span>
          <span class="method-tag">Redispatch optimization</span>
          <span class="method-tag">Balancing coordination</span>
          <span class="method-tag">Hybrid AC/DC grids</span>
          <span class="method-tag">HVDC controllability</span>
          <span class="method-tag">Operational risk</span>
        </div>

        <h2>Affiliations</h2>

        <p>
          I am a doctoral researcher at
          <a href="https://www.kuleuven.be" target="_blank" rel="noopener noreferrer">KU Leuven</a>
          and affiliated with
          <a href="https://www.energyville.be" target="_blank" rel="noopener noreferrer">EnergyVille</a>
          through the Energy Transmission Competence Hub (Etch), which focuses on research and
          development for future electricity transmission systems.
        </p>

      </div>
    </div>
  </div>
</main>
