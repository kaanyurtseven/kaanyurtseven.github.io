---
layout: default
title: Research
permalink: /research/
load_map: true
description: >
  Research on stochastic optimization, congestion management under uncertainty,
  hybrid AC/DC grids, and risk-aware decision support for power system operation and planning.
---

<style>
  .research-wide p,
  .research-wide .page-header__subtitle,
  .research-wide .map-section__subtitle { max-width: none; }
</style>

<main class="site-main" id="main-content">
  <div class="container research-wide">

    <header class="page-header">
      <h1 class="page-header__title">Research</h1>
      <p class="page-header__subtitle">
        Stochastic optimization and risk-aware decision support for power system operation and planning.
      </p>
    </header>

    <div class="prose" style="margin-bottom: var(--space-4);">
      <p>
        My research focuses on how uncertainty shapes power system operation and how optimization
        can support better decisions under these conditions. Although this work is technical in
        nature, it has also been shaped by people, places, and conversations across different
        settings. The map below offers a more personal way to explore that side of the journey.
      </p>
    </div>

    {% include map.html %}

    <div class="prose">

      <p>
        As renewable generation increases, uncertainty propagates into both congestion
        management and real-time balancing, coupling decisions across time horizons that are
        often treated independently in practice.
      </p>

      <p>
        I develop stochastic optimization frameworks that capture uncertainty continuously and
        quantify its impact on operational decisions. This enables a transparent understanding
        of how probabilistic forecasts influence congestion patterns, redispatch actions, and
        balancing requirements, supporting more efficient and risk-aware system operation.
      </p>

    </div>

    <!-- Research Areas -->
    <div style="margin-top: 3rem;">

      <div class="research-area">
        <p class="research-area__number">01</p>
        <h2 class="research-area__title">Congestion management and balancing under uncertainty</h2>
        <div class="prose">
          <p>
            This research focuses on the coordinated treatment of congestion management and
            balancing, which are traditionally addressed independently. By modeling their
            interaction explicitly, the proposed frameworks enable more efficient operational
            planning and avoid cost increases and risk exposure caused by decoupled
            decision-making.
          </p>
        </div>
      </div>

      <div class="research-area">
        <p class="research-area__number">02</p>
        <h2 class="research-area__title">Quantifying the impact of uncertainty on operational decisions</h2>
        <div class="prose">
          <p>
            A central objective is to understand how uncertainty affects decisions rather than
            treating it as an abstract input. This includes quantifying how probabilistic
            forecasts of renewable generation and demand influence congestion patterns,
            redispatch actions, and balancing requirements, thereby providing a transparent
            link between uncertainty and system operation.
          </p>
        </div>
      </div>

      <div class="research-area">
        <p class="research-area__number">03</p>
        <h2 class="research-area__title">Optimization under non-Gaussian uncertainty</h2>
        <div class="prose">
          <p>
            The work develops stochastic optimization approaches that operate in continuous
            uncertainty spaces without relying on Gaussian assumptions. By capturing skewness
            and bounded behavior in renewable generation, these methods provide a more realistic
            representation of uncertainty and improve the reliability of operational decisions.
          </p>
        </div>
      </div>

      <div class="research-area">
        <p class="research-area__number">04</p>
        <h2 class="research-area__title">Polynomial Chaos Expansion for scalable uncertainty propagation</h2>
        <div class="prose">
          <p>
            Intrusive Polynomial Chaos Expansion is leveraged to propagate uncertainty through
            nonlinear power system models in a computationally tractable manner. This enables
            the evaluation of statistical properties of system states and costs without relying
            on large sets of discrete scenarios, improving scalability with respect to
            uncertainty dimensions.
          </p>
        </div>
      </div>

      <div class="research-area">
        <p class="research-area__number">05</p>
        <h2 class="research-area__title">Hybrid AC/DC grids and HVDC controllability</h2>
        <div class="prose">
          <p>
            The research investigates how HVDC technologies influence congestion management
            strategies and operational flexibility. By incorporating controllable DC links into
            optimization frameworks, it becomes possible to analyze their role in reducing
            congestion costs and balancing risks in future meshed AC/DC grids.
          </p>
        </div>
      </div>

    </div>

    <!-- Methods box -->
    <div style="margin-top: 3rem; padding: 1.5rem 2rem; background: var(--surface); border: 1px solid var(--border); border-radius: 4px;">
      <div class="method-groups">

        <div class="method-group">
          <p class="method-group__label">Methods and frameworks</p>
          <div class="method-tags">
            <span class="method-tag">Polynomial Chaos Expansion</span>
            <span class="method-tag">Stochastic optimal power flow</span>
            <span class="method-tag">Chance-constrained optimization</span>
            <span class="method-tag">Risk measures (CVaR, VaR)</span>
            <span class="method-tag">Stochastic programming</span>
          </div>
        </div>

        <div class="method-group">
          <p class="method-group__label">Uncertainty and modeling</p>
          <div class="method-tags">
            <span class="method-tag">Non-Gaussian uncertainty</span>
            <span class="method-tag">Continuous uncertainty representation</span>
            <span class="method-tag">Uncertainty propagation</span>
            <span class="method-tag">Forecast uncertainty analysis</span>
          </div>
        </div>

        <div class="method-group">
          <p class="method-group__label">Applications and systems</p>
          <div class="method-tags">
            <span class="method-tag">Congestion management</span>
            <span class="method-tag">Redispatch optimization</span>
            <span class="method-tag">Balancing coordination</span>
            <span class="method-tag">Hybrid AC/DC grids</span>
            <span class="method-tag">HVDC controllability</span>
            <span class="method-tag">Renewable integration</span>
            <span class="method-tag">Operational risk</span>
          </div>
        </div>

      </div>
    </div>

    <div style="margin-top: 2.5rem; padding-top: 2rem; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-4);">
      <a href="{{ '/tools/' | relative_url }}" class="link-arrow">Decision support tools and code</a>
      <a href="{{ '/publications/' | relative_url }}" class="link-arrow">View publications</a>
    </div>

  </div>
</main>
