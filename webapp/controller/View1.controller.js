sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/SelectDialog",
	"sap/m/StandardListItem",
	"sap/viz/ui5/controls/Popover",
	"sap/ui/Device",
	"sap/ui/export/Spreadsheet",
	"sap/ui/export/library",
	"sap/ui/model/type/Float" // preload only: used as a type in View1.view.xml (avoids a sync load)
], function(Controller, JSONModel, Filter, FilterOperator, SelectDialog, StandardListItem, VizPopover, Device, Spreadsheet, exportLibrary) {
	"use strict";

	var DEBUG = true;
	var LOG_PREFIX = "[PRPOGR-SCREEN1] ";
	var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	var QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
	// Horizon-style series colours: PR blue, PO orange, GRN green
	var SERIES_COLORS = ["#0070F2", "#E9730C", "#30914C"];

	// TODO-CONFIRM: how the backend expects Quarter (tested so far: only Month = "06" works).
	// If TypeofRep eq 'Q' returns nothing for "Q1", try "01" or "1" here.
	function quarterParameter(number) {
		return "Q" + number;
	}

	return Controller.extend("Z_PR_PO_Report_GC.controller.View1", {

		/* =========================================================== */
		/* Lifecycle                                                   */
		/* =========================================================== */
		onInit: function() {
			var now = new Date();
			var currentYear = now.getFullYear();
			var years = [];
			for (var year = currentYear + 1; year >= currentYear - 10; year -= 1) {
				years.push({
					key: String(year),
					text: String(year)
				});
			}

			this._requestPending = false;
			this._requestSerial = 0;
			this._retryAction = null;
			this._detailRequestSerial = 0;
			this._detailRetryPeriod = null;
			this._vizPopovers = {};

			// Reserve space for ChartContainer's toolbar while keeping the split section height fixed.
			var chartHeight = Device.system.phone ? "11rem" : (Device.system.tablet ? "13rem" : "15rem");
			var chartViewportHeight = Device.system.phone ? "15rem" : (Device.system.tablet ? "17rem" : "19rem");
			var tableHeight = Device.system.phone ? "18rem" : (Device.system.tablet ? "20rem" : "22rem");

			this._logInfo("Initialization", {
				ui5Version: sap.ui.version,
				serviceBasePath: "/sap/opu/odata/sap/ZO_MM_PRPOGR_QTY_SRV/",
				modelAvailable: !!this.getOwnerComponent().getModel()
			});

			this.getView().setModel(new JSONModel({
				plants: [],
				years: years,
				subPeriods: [],
				periods: [],
				searched: false,
				hasData: false,
				showNoData: false,
				hasError: false,
				canRetry: false,
				busy: false,
				plantsBusy: false,
				selectedPeriod: null,
				contextText: "",
				selection: {
					plant: "",
					// type: "M",
					type: "Y",
					year: String(currentYear),
					subPeriod: ""
				},
				valueState: {
					plant: "None",
					year: "None",
					subPeriod: "None"
				},
				valueText: {
					plant: "",
					year: "",
					subPeriod: ""
				},
				ui: {
					chartHeight: chartHeight,
					chartViewportHeight: chartViewportHeight,
					chartWidth: "720px",
					tableHeight: tableHeight,
					subPeriodLabel: "Month"
				}
			}), "screen1");

			this.getView().setModel(new JSONModel({
				selectedPeriod: null,
				contextText: "",
				viewMode: "graphical",
				busy: false,
				hasData: false,
				noData: false,
				errorText: "",
				valueWarningText: "",
				rows: [],
				visibleRows: [],
				visibleTreeRows: [],
				activeKpi: "",
				activeKpiText: "",
				searchQuery: "",
				hasTableFilters: false,
				tableSummaryText: "",
				kpis: [],
				pipeline: [],
				leadTime: [],
				monthlyValue: [],
				topVendors: [],
				monthlyChartTitle: "Monthly PR Value by Status",
				topVendorsChartTitle: "Top Vendors – PR Value"
			}), "detail");

			this._updateSubPeriods(true);
			this._configureChart();
			this._configureDetailCharts();
			this._loadPlantValues();

			var odataModel = this.getOwnerComponent().getModel();
			if (odataModel && odataModel.metadataLoaded) {
				odataModel.metadataLoaded().then(function() {
					this._logInfo("Metadata loaded", {});
				}.bind(this), function(error) {
					this._logError("Metadata loading failed", error);
					this._showMessage("The service metadata could not be loaded. Check the service and your connection.", "Error", false);
				}.bind(this));
			}
		},

		onAfterRendering: function() {
			this._connectChartPopover(this.byId("quantityChart"));
			[
				"detailPipelineChart",
				"detailLeadTimeChart",
				"detailMonthlyValueChart",
				"detailTopVendorsChart"
			].forEach(function(id) {
				this._connectChartPopover(this.byId(id));
			}.bind(this));
		},

		_connectChartPopover: function(chart) {
			if (!chart || !chart.getVizUid || this._vizPopovers[chart.getId()]) {
				return;
			}
			var vizUid = chart.getVizUid();
			if (!vizUid) {
				return;
			}
			var popover = new VizPopover();
			popover.connect(vizUid);
			this.getView().addDependent(popover);
			this._vizPopovers[chart.getId()] = popover;
		},

		/* =========================================================== */
		/* Plant value help                                            */
		/* =========================================================== */
		_loadPlantValues: function() {
			var model = this.getOwnerComponent().getModel();
			var vm = this.getView().getModel("screen1");
			if (!model) {
				this._showMessage("The OData service model is not configured.", "Error", false);
				return;
			}
			var t0 = Date.now();
			vm.setProperty("/plantsBusy", true);
			model.read("/I_PlantVH", {
				urlParameters: {
					"$select": "Plant,PlantName",
					"$orderby": "Plant"
				},
				success: function(response) {
					var plants = response && Array.isArray(response.results) ? response.results : [];
					vm.setProperty("/plants", plants);
					vm.setProperty("/plantsBusy", false);
					this._logInfo("Plant values loaded", {
						recordCount: plants.length,
						ms: Date.now() - t0
					});
					if (!plants.length) {
						this._showMessage("No plant values are available.", "Warning", false);
					}
				}.bind(this),
				error: function(error) {
					vm.setProperty("/plantsBusy", false);
					this._handleODataError(error, "Plant value-help loading failed", "Could not load plant values.", this._loadPlantValues.bind(
						this));
				}.bind(this)
			});
		},

		onPlantValueHelp: function() {
			if (!this._plantDialog) {
				this._plantDialog = new SelectDialog({
					title: "Select Plant",
					noDataText: "No plant values available",
					searchPlaceholder: "Search plant code or description",
					rememberSelections: false,
					items: {
						path: "screen1>/plants",
						template: new StandardListItem({
							title: "{screen1>Plant}",
							description: "{screen1>PlantName}",
							info: "{screen1>Plant}",
							type: "Active"
						})
					},
					search: this.onPlantDialogSearch.bind(this),
					liveChange: this.onPlantDialogSearch.bind(this),
					confirm: this.onPlantDialogConfirm.bind(this)
				});
				this._plantDialog.setModel(this.getView().getModel("screen1"), "screen1");
				this.getView().addDependent(this._plantDialog);
			}
			var binding = this._plantDialog.getBinding("items");
			if (binding) {
				binding.filter([]);
			}
			this._plantDialog.open();
		},

		onPlantDialogSearch: function(event) {
			var query = String(event.getParameter("value") || "").trim();
			var binding = event.getSource().getBinding("items");
			if (!binding) {
				return;
			}
			if (!query) {
				binding.filter([]);
				return;
			}
			binding.filter(new Filter({
				filters: [
					new Filter("Plant", FilterOperator.Contains, query),
					new Filter("PlantName", FilterOperator.Contains, query)
				],
				and: false
			}));
		},

		onPlantDialogConfirm: function(event) {
			var item = event.getParameter("selectedItem");
			if (!item) {
				return;
			}
			var context = item.getBindingContext("screen1");
			this.getView().getModel("screen1").setProperty("/selection/plant", context.getProperty("Plant"));
			this._setFieldState("plant", "None", "");
			this._markStale();
			this._logInfo("Plant selected", {
				Plant: context.getProperty("Plant"),
				PlantName: context.getProperty("PlantName")
			});
		},

		/* =========================================================== */
		/* Selection criteria                                          */
		/* =========================================================== */
		onPlantChange: function(event) {
			var input = event.getSource();
			var plant = String(input.getValue() || "").trim().toUpperCase();
			input.setValue(plant);
			this.getView().getModel("screen1").setProperty("/selection/plant", plant);
			var known = (this.getView().getModel("screen1").getProperty("/plants") || []).some(function(item) {
				return item.Plant === plant;
			});
			if (plant && !known) {
				this._setFieldState("plant", "Error", "Enter a valid plant code or select one from value help.");
			} else {
				this._setFieldState("plant", "None", "");
			}
			this._markStale();
		},
		onPlantSuggestionSelected: function(event) {
			var item = event.getParameter("selectedItem");
			if (!item) {
				return;
			}
			var plant = item.getKey();
			event.getSource().setValue(plant);
			this.getView().getModel("screen1").setProperty("/selection/plant", plant);
			this._setFieldState("plant", "None", "");
			this._markStale();
			this._logInfo("Plant suggestion selected", {
				Plant: plant
			});
		},
		onYearChange: function() {
			this._setFieldState("year", "None", "");
			this._markStale();
		},
		onSubPeriodChange: function(event) {
			this.getView().getModel("screen1").setProperty("/selection/subPeriod", event.getSource().getSelectedKey());
			this._setFieldState("subPeriod", "None", "");
			this._markStale();
		},
		onReportTypeChange: function(event) {
			var selectedKey = event.getSource().getSelectedKey();
			this.getView().getModel("screen1").setProperty("/selection/type", selectedKey);
			this._logInfo("Report type changed", {
				reportType: selectedKey
			});
			this._updateSubPeriods(true);
			this._setFieldState("subPeriod", "None", "");
			this._markStale();
		},

		_updateSubPeriods: function(resetToCurrent) {
			var vm = this.getView().getModel("screen1");
			var type = vm.getProperty("/selection/type");
			var options = [{
				key: "",
				text: type === "Q" ? "Select a quarter" : "Select a month",
				enabled: false
			}];
			if (type === "M") {
				options = options.concat(MONTHS.map(function(text, i) {
					return {
						key: String(i + 1),
						text: text,
						enabled: true
					};
				}));
			} else if (type === "Q") {
				options = options.concat(QUARTERS.map(function(text, i) {
					return {
						key: String(i + 1),
						text: text,
						enabled: true
					};
				}));
			}
			vm.setProperty("/subPeriods", options);
			vm.setProperty("/ui/subPeriodLabel", type === "Q" ? "Quarter" : "Month");
			if (resetToCurrent) {
				vm.setProperty("/selection/subPeriod", "");
			}
		},

		_setFieldState: function(field, state, text) {
			var vm = this.getView().getModel("screen1");
			vm.setProperty("/valueState/" + field, state);
			vm.setProperty("/valueText/" + field, text);
		},

		_validateSelection: function() {
			var vm = this.getView().getModel("screen1");
			var selection = vm.getProperty("/selection");
			var errors = [];

			var plantKnown = (vm.getProperty("/plants") || []).some(function(item) {
				return item.Plant === selection.plant;
			});
			if (!selection.plant) {
				errors.push("Plant is required.");
				this._setFieldState("plant", "Error", "Plant is required.");
			} else if (!plantKnown) {
				errors.push("Select a valid plant from the list.");
				this._setFieldState("plant", "Error", "Select a valid plant from the list.");
			} else {
				this._setFieldState("plant", "None", "");
			}

			var yearValid = /^\d{4}$/.test(selection.year || "") && (vm.getProperty("/years") || []).some(function(item) {
				return item.key === selection.year;
			});
			if (!yearValid) {
				errors.push("Select a valid year.");
				this._setFieldState("year", "Error", "Select a valid year.");
			} else {
				this._setFieldState("year", "None", "");
			}

			var typeValid = ["M", "Q", "Y"].indexOf(selection.type) !== -1;
			if (!typeValid) {
				errors.push("Select a report type.");
			}

			var periodValid = true;
			if (typeValid && selection.type !== "Y") {
				var selectedPeriod = String(selection.subPeriod || "");
				var validPeriodKeys = (vm.getProperty("/subPeriods") || []).map(function(item) {
					return item.key;
				});
				periodValid = !!selectedPeriod && validPeriodKeys.indexOf(selectedPeriod) !== -1;
				if (!periodValid) {
					var text = selection.type === "M" ? "Select a month." : "Select a quarter.";
					errors.push(text);
					this._setFieldState("subPeriod", "Error", text);
				} else {
					this._setFieldState("subPeriod", "None", "");
				}
			} else {
				this._setFieldState("subPeriod", "None", "");
			}

			var valid = errors.length === 0;
			this._logInfo("Selection validation", {
				valid: valid,
				errors: errors,
				plant: selection.plant,
				reportType: selection.type,
				year: selection.year,
				period: selection.subPeriod
			});
			if (!valid) {
				this._showMessage("Please correct the highlighted fields: " + errors.join(" "), "Error", false);
			}
			return valid;
		},

		_markStale: function() {
			var vm = this.getView().getModel("screen1");
			if (vm.getProperty("/hasData") && !vm.getProperty("/busy")) {
				this._showMessage("Selection changed. Choose Get Data to refresh the results.", "Information", false);
			}
		},

		/* =========================================================== */
		/* Get Data / summary request                                  */
		/* =========================================================== */
		onGetData: function() {
			if (this._requestPending) {
				return;
			}
			this._clearMessage();
			if (!this._validateSelection()) {
				return;
			}
			this._loadPeriodWiseData();
		},

		onRetry: function() {
			this._logInfo("Retry requested", {});
			if (typeof this._retryAction === "function") {
				this._clearMessage();
				this._retryAction();
			}
		},

		_loadPeriodWiseData: function() {
			var vm = this.getView().getModel("screen1");
			var model = this.getOwnerComponent().getModel();
			var selection = vm.getProperty("/selection");
			var params = this._buildRequestParameters(selection);
			var serial = ++this._requestSerial;
			var t0 = Date.now();

			if (!model) {
				this._showMessage("The OData service model is not configured.", "Error", false);
				return;
			}

			vm.setProperty("/searched", true);
			vm.setProperty("/hasData", false);
			vm.setProperty("/showNoData", false);
			vm.setProperty("/hasError", false);
			vm.setProperty("/periods", []);
			this._clearPeriodSelection();
			this._setBusy(true);

			var filters = [
				new Filter("Werks", FilterOperator.EQ, params.Werks),
				new Filter("TypeofRep", FilterOperator.EQ, params.TypeofRep),
				new Filter("Year", FilterOperator.EQ, params.Year)
			];
			if (params.Month) {
				filters.push(new Filter("Month", FilterOperator.EQ, params.Month));
			}
			if (params.Quarter) {
				filters.push(new Filter("Quarter", FilterOperator.EQ, params.Quarter));
			}
			this._logInfo("Summary request", {
				entitySet: "PRPOGRN_QuantitySet",
				parameters: params,
				serial: serial
			});

			model.read("/PRPOGRN_QuantitySet", {
				filters: filters,
				success: function(response) {
					if (serial !== this._requestSerial) {
						this._logInfo("Stale summary response ignored", {
							serial: serial,
							current: this._requestSerial
						});
						return;
					}
					try {
						var periods = this._processPeriodWiseResponse(response, params.TypeofRep);
						this._fitChartPending = periods.length > 0;
						vm.setProperty("/ui/chartWidth", Math.max(720, periods.length * 140) + "px");
						vm.setProperty("/periods", periods);
						vm.setProperty("/hasData", periods.length > 0);
						vm.setProperty("/showNoData", periods.length === 0);
						vm.setProperty("/contextText", this._buildContextText(selection));
						this._logInfo("Summary loaded", {
							rows: periods.length,
							ms: Date.now() - t0
						});
					} catch (e) {
						vm.setProperty("/hasError", true);
						this._logError("Summary processing failed", e);
						this._showMessage("The period data could not be processed.", "Error", true);
						this._retryAction = this._loadPeriodWiseData.bind(this);
					} finally {
						this._setBusy(false);
					}
				}.bind(this),
				error: function(error) {
					if (serial !== this._requestSerial) {
						return;
					}
					vm.setProperty("/hasError", true);
					this._setBusy(false);
					this._handleODataError(error, "Period data loading failed", "Could not load the period data.", this._loadPeriodWiseData.bind(
						this));
				}.bind(this)
			});
		},

		_buildRequestParameters: function(selection) {
			var result = {
				Werks: selection.plant,
				TypeofRep: selection.type,
				Year: selection.year
			};
			if (selection.type === "M") {
				result.Month = ("0" + selection.subPeriod).slice(-2); // backend returns Month values such as "06"
			}
			if (selection.type === "Q") {
				result.Quarter = quarterParameter(selection.subPeriod);
			}
			return result;
		},

		_buildContextText: function(selection) {
			var vm = this.getView().getModel("screen1");
			var plant = (vm.getProperty("/plants") || []).filter(function(item) {
				return item.Plant === selection.plant;
			})[0];
			var plantText = plant ? plant.Plant + " – " + plant.PlantName : selection.plant;
			var period = selection.year;
			if (selection.type === "M") {
				period = MONTHS_SHORT[parseInt(selection.subPeriod, 10) - 1] + " " + selection.year;
			} else if (selection.type === "Q") {
				period = "Q" + selection.subPeriod + " " + selection.year;
			}
			return plantText + "  |  " + period;
		},

		_buildDetailContextText: function(period) {
			var plants = this.getView().getModel("screen1").getProperty("/plants") || [];
			var plant = plants.filter(function(item) {
				return item.Plant === period.Werks;
			})[0];
			var plantText = period.Werks || "";
			if (plant && plant.PlantName) {
				plantText += " – " + plant.PlantName;
			}
			return plantText + "  |  " + (period.period || "");
		},

		_loadDetailsForPeriod: function(period) {
			var detailModel = this.getView().getModel("detail");
			var serviceModel = this.getOwnerComponent().getModel();
			var fromParts = this._parseYmd(period.FromDate);
			var toParts = this._parseYmd(period.ToDate);
			var requestId = ++this._detailRequestSerial;
			var detailsPanel = this.byId("detailsPanel");

			if (detailsPanel && !detailsPanel.getExpanded()) {
				detailsPanel.setExpanded(true);
			}
			// Bring the expanded detail section into view after the panel has rendered.
			this._scrollDetailsPanelIntoView();
			this._detailRetryPeriod = period;
			detailModel.setData({
				selectedPeriod: period,
				contextText: this._buildDetailContextText(period),
				viewMode: "graphical",
				busy: true,
				hasData: false,
				noData: false,
				errorText: "",
				valueWarningText: "",
				rows: [],
				visibleRows: [],
				visibleTreeRows: [],
				activeKpi: "",
				activeKpiText: "",
				searchQuery: "",
				hasTableFilters: false,
				tableSummaryText: "",
				kpis: [],
				pipeline: [],
				leadTime: [],
				monthlyValue: [],
				topVendors: [],
				monthlyChartTitle: "Monthly PR Value by Status",
				topVendorsChartTitle: "Top Vendors – PR Value"
			});

			if (!serviceModel) {
				this._setDetailError("The OData service model is not configured.", requestId);
				return;
			}
			if (!period.Werks || !fromParts || !toParts) {
				this._setDetailError("The selected period is missing a plant or valid date range.", requestId);
				return;
			}

			// Build UTC-midnight values so OData serialization does not shift dates to the previous day in IST.
			var fromDate = new Date(Date.UTC(fromParts.y, fromParts.m - 1, fromParts.d));
			var toDate = new Date(Date.UTC(toParts.y, toParts.m - 1, toParts.d));
			// Keep both bounds on badat_pr as an AND range; same-property filters otherwise default to OR.
			var dateRangeFilter = new Filter({
				filters: [
					new Filter("badat_pr", FilterOperator.GE, fromDate),
					new Filter("badat_pr", FilterOperator.LE, toDate)
				],
				and: true
			});
			var filters = [
				new Filter("werks", FilterOperator.EQ, period.Werks),
				dateRangeFilter
			];
			this._logInfo("Detail dashboard request", {
				entitySet: "/ZI_MM_PO_PR_GRN",
				plant: period.Werks,
				fromDate: period.FromDate,
				toDate: period.ToDate,
				filters: filters
			});

			serviceModel.read("/ZI_MM_PO_PR_GRN", {
				filters: filters,
				success: function(response) {
					if (requestId !== this._detailRequestSerial) {
						this._logInfo("Stale detail response ignored", {
							requestId: requestId
						});
						return;
					}
					try {
						var sourceRows = response && Array.isArray(response.results) ? response.results : null;
						if (!sourceRows) {
							throw new Error("Unexpected ZI_MM_PO_PR_GRN response structure.");
						}
						var result = this._buildDetailDashboard(sourceRows);
						detailModel.setProperty("/rows", result.rows);
						detailModel.setProperty("/activeKpi", "");
						detailModel.setProperty("/activeKpiText", "");
						detailModel.setProperty("/searchQuery", "");
						detailModel.setProperty("/kpis", result.kpis);
						detailModel.setProperty("/pipeline", result.pipeline);
						detailModel.setProperty("/leadTime", result.leadTime);
						detailModel.setProperty("/monthlyValue", result.monthlyValue);
						detailModel.setProperty("/topVendors", result.topVendors);
						detailModel.setProperty("/monthlyChartTitle", result.monthlyChartTitle);
						detailModel.setProperty("/topVendorsChartTitle", result.topVendorsChartTitle);
						detailModel.setProperty("/valueWarningText", result.valueWarningText);
						detailModel.setProperty("/busy", false);
						detailModel.setProperty("/hasData", sourceRows.length > 0);
						detailModel.setProperty("/noData", sourceRows.length === 0);
						this._applyDetailTableFilters();
						this._syncKpiCardSelection();
						this._logInfo("Detail dashboard loaded", {
							requestId: requestId,
							rawRows: sourceRows.length,
							uniquePRLines: result.kpis[0].rawValue,
							kpis: result.kpis
						});
					} catch (error) {
						this._logError("Detail response processing failed", error);
						this._setDetailError("The detail response could not be processed. Check the returned field names and values.", requestId);
					}
				}.bind(this),
				error: function(error) {
					if (requestId !== this._detailRequestSerial) {
						return;
					}
					var parsed = this._parseError(error, "Could not load details for the selected period.");
					this._logError("Detail dashboard request failed", {
						status: parsed.status,
						message: parsed.message,
						raw: error
					});
					this._setDetailError(parsed.message, requestId);
				}.bind(this)
			});
		},

		onRetryDetails: function() {
			if (this._detailRetryPeriod) {
				this._loadDetailsForPeriod(this._detailRetryPeriod);
			}
		},

		_setDetailError: function(message, requestId) {
			if (requestId !== this._detailRequestSerial) {
				return;
			}
			var detailModel = this.getView().getModel("detail");
			detailModel.setProperty("/busy", false);
			detailModel.setProperty("/hasData", false);
			detailModel.setProperty("/noData", false);
			detailModel.setProperty("/errorText", message);
		},

		onKpiPress: function(event) {
			var kpi = event.getSource().getBindingContext("detail").getObject();
			var detailModel = this.getView().getModel("detail");
			var currentFilter = detailModel.getProperty("/activeKpi");
			var nextFilter = currentFilter === kpi.filterKey ? "" : kpi.filterKey;
			detailModel.setProperty("/viewMode", "table");
			detailModel.setProperty("/activeKpi", nextFilter);
			detailModel.setProperty("/searchQuery", "");
			this.byId("detailSearch").setValue("");
			this._applyDetailTableFilters();
			this._syncKpiCardSelection();
			this._focusDetailSectionIntoView("detailTableSection");
		},

		onDetailViewChange: function(event) {
			var viewMode = event.getSource().getSelectedKey();
			var detailModel = this.getView().getModel("detail");
			detailModel.setProperty("/viewMode", viewMode === "table" ? "table" : "graphical");
			this._focusDetailSectionIntoView(viewMode === "table" ? "detailTableSection" : "detailGraphicalView");
		},

		onDetailSearch: function(event) {
			var value = event.getParameter("newValue");
			if (value === undefined) {
				value = event.getSource().getValue();
			}
			this.getView().getModel("detail").setProperty("/searchQuery", value || "");
			this._applyDetailTableFilters();
		},

		onClearDetailTableFilters: function() {
			this.getView().getModel("detail").setProperty("/activeKpi", "");
			this.getView().getModel("detail").setProperty("/searchQuery", "");
			this.byId("detailSearch").setValue("");
			this._applyDetailTableFilters();
			var table = this.byId("detailsTable");
			table.getColumns().forEach(function(column) {
				if (column.getFiltered()) {
					table.filter(column, "");
				}
			});
			this._syncKpiCardSelection();
		},

		_applyDetailTableFilters: function() {
			var model = this.getView().getModel("detail");
			var rows = model.getProperty("/rows") || [];
			var filterKey = model.getProperty("/activeKpi") || "";
			var query = String(model.getProperty("/searchQuery") || "").trim().toLowerCase();
			var kpi = (model.getProperty("/kpis") || []).filter(function(item) {
				return item.filterKey === filterKey;
			})[0];
			var searchableFields = ["banfn", "bnfpo", "werks", "ebeln", "ebelp", "name1", "lifnr", "TXZ01", "matnr", "afnam_pr", "kostl_pr",
				"sakto_pr", "ekgrp", "Status", "mblnr"
			];
			var visibleRows = rows.filter(function(row) {
				var matchesKpi = true;
				switch (filterKey) {
					case "PR_VALUE":
						matchesKpi = row.PRValue !== null && !!row.Currency;
						break;
					case "PO_COVERAGE":
						matchesKpi = row.Status === "No PO Yet";
						break;
					case "FULLY_RECEIVED":
						matchesKpi = row.Status === "Fully Received";
						break;
					case "OPEN_PR":
						matchesKpi = !this._isBlank(row.ebeln) && row.PendingQtyValue !== null && row.PendingQtyValue > 0;
						break;
					case "VALUE_PENDING":
						matchesKpi = !this._isBlank(row.ebeln) && row.PendingQtyValue !== null && row.PendingQtyValue > 0 &&
							row.UnitPriceValue !== null && !!row.Currency;
						break;
				}
				if (!matchesKpi || !query) {
					return matchesKpi;
				}
				return searchableFields.some(function(field) {
					return String(row[field] === null || row[field] === undefined ? "" : row[field]).toLowerCase().indexOf(query) !== -1;
				});
			}.bind(this));
			var hierarchy = this._buildDetailHierarchy(visibleRows);
			var summary = hierarchy.prItemCount + " PR items · " + hierarchy.poItemCount + " PO items · " + hierarchy.grItemCount +
				" distinct GR items";
			if (kpi) {
				summary = kpi.label + " · " + summary;
			}
			model.setProperty("/visibleRows", visibleRows);
			model.setProperty("/visibleTreeRows", hierarchy.rows);
			// Each KPI/search refresh rebuilds the tree; collapse it so expansions from
			// the previous result set do not carry over onto unrelated rows.
			var detailTree = this.byId("detailsTable");
			if (detailTree && detailTree.collapseAll) {
				detailTree.collapseAll();
			}
			model.setProperty("/activeKpiText", kpi ? kpi.label : "");
			model.setProperty("/tableSummaryText", summary);
			model.setProperty("/hasTableFilters", !!filterKey || !!query);
		},

		_buildDetailHierarchy: function(rows) {
			var rootsByPRItem = {};
			var roots = [];
			var prFields = ["banfn", "bnfpo", "werks", "badat_pr", "BadatText", "FRGDT", "PRReleaseText", "afnam_pr", "TXZ01", "matnr",
				"Currency", "PRQtyValue", "PRQtyText", "meins_pr", "PRValue", "PRValueLakhValue", "PRTotalValueText", "UnitPriceValue",
				"UnitPriceLakhValue", "PRUnitPriceText", "kostl_pr", "sakto_pr"
			];
			var poFields = ["ekgrp", "name1", "lifnr", "ebeln", "ebelp", "aedat_po", "PODateText", "release_date", "POReleaseText", "eindt",
				"DeliveryText", "POQtyValue", "POQtyText", "meins_po", "PendingQtyValue", "PendingQtyText", "days_between_pr_po", "LeadDaysValue"
			];
			var grFields = ["mblnr", "mjahr", "ZEILE", "GRDateText", "GRQtyValue", "GRQtyText", "gr_meins", "gr_date", "GRDocItemText"];
			var poItemCount = 0;
			var grItemCount = 0;

			function clearFields(target, fields) {
				fields.forEach(function(field) {
					target[field] = "";
				});
			}

			rows.forEach(function(row) {
				var prKey = row.PRLineKey;
				var prNode = rootsByPRItem[prKey];
				if (!prNode) {
					prNode = Object.assign({}, row, {
						NodeType: "PR",
						NodeLabel: "PR " + String(row.banfn || "") + " · Item " + String(row.bnfpo || ""),
						children: [],
						_poNodes: {},
						_grNodes: {}
					});
					clearFields(prNode, poFields.concat(grFields));
					rootsByPRItem[prKey] = prNode;
					roots.push(prNode);
				}

				var poNode = null;
				if (!this._isBlank(row.ebeln)) {
					var poKey = prKey + "|" + String(row.ebeln) + "|" + String(row.ebelp || "");
					poNode = prNode._poNodes[poKey];
					if (!poNode) {
						poNode = Object.assign({}, row, {
							NodeType: "PO",
							NodeLabel: "PO " + String(row.ebeln) + (this._isBlank(row.ebelp) ? "" : " · Item " + String(row.ebelp)),
							Status: "",
							StatusState: "None",
							children: [],
							_grNodes: {}
						});
						clearFields(poNode, prFields.concat(grFields));
						prNode._poNodes[poKey] = poNode;
						prNode.children.push(poNode);
						poItemCount += 1;
					}
				}

				if (!this._isBlank(row.mblnr)) {
					var parentNode = poNode || prNode;
					var grKey = [row.mblnr, row.mjahr, row.ZEILE].join("|");
					if (!parentNode._grNodes[grKey]) {
						var grNode = Object.assign({}, row, {
							NodeType: "GR",
							NodeLabel: "GR " + String(row.mblnr) + " · " + String(row.mjahr || "") +
								(this._isBlank(row.ZEILE) ? "" : " / Item " + String(row.ZEILE)),
							Status: "",
							StatusState: "None",
							children: []
						});
						clearFields(grNode, prFields.concat(poFields));
						parentNode._grNodes[grKey] = true;
						parentNode.children.push(grNode);
						grItemCount += 1;
					}
				}
			}.bind(this));

			roots.forEach(function(prNode) {
				delete prNode._poNodes;
				delete prNode._grNodes;
				prNode.children.forEach(function(poNode) {
					delete poNode._grNodes;
				});
			});
			return {
				rows: roots,
				prItemCount: roots.length,
				poItemCount: poItemCount,
				grItemCount: grItemCount
			};
		},

		_syncKpiCardSelection: function() {
			var grid = this.byId("kpiGrid");
			if (!grid) {
				return;
			}
			var activeKpi = this.getView().getModel("detail").getProperty("/activeKpi");
			var toneByFilter = {
				ALL: "prpoKpiTonePRLines",
				PR_VALUE: "prpoKpiTonePRValue",
				PO_COVERAGE: "prpoKpiToneCoverage",
				FULLY_RECEIVED: "prpoKpiToneReceived",
				OPEN_PR: "prpoKpiToneOpenPR",
				VALUE_PENDING: "prpoKpiTonePendingValue"
			};
			var toneClasses = Object.keys(toneByFilter).map(function(key) {
				return toneByFilter[key];
			});
			grid.getItems().forEach(function(tile) {
				var context = tile.getBindingContext("detail");
				var kpi = context && context.getObject();
				var toneClass = kpi && toneByFilter[kpi.filterKey];
				toneClasses.forEach(function(className) {
					tile.toggleStyleClass(className, className === toneClass);
				});
				tile.toggleStyleClass("prpoKpiCardActive", !!kpi && !!activeKpi && kpi.filterKey === activeKpi);
			});
		},

		_focusDetailSectionIntoView: function(sectionId) {
			var schedule = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function(callback) {
				setTimeout(callback, 0);
			};
			var attempts = 0;
			var scrollWhenVisible = function() {
				var section = this.byId(sectionId);
				var page = this.byId("page");
				var domRef = section && section.getDomRef();
				var rect = domRef && domRef.getBoundingClientRect();
				if (domRef && (!rect || rect.height === 0) && attempts < 6) {
					attempts += 1;
					schedule(scrollWhenVisible);
					return;
				}
				var pageDom = page && page.getDomRef();
				var pageScroller = pageDom && pageDom.querySelector(".sapMPageEnableScrolling");
				if (domRef && pageScroller && page && page.scrollTo) {
					var targetTop = pageScroller.scrollTop + rect.top - pageScroller.getBoundingClientRect().top;
					page.scrollTo(Math.max(0, targetTop - 8), 250);
				} else if (domRef && domRef.scrollIntoView) {
					domRef.scrollIntoView({
						behavior: "smooth",
						block: "start"
					});
				}
			}.bind(this);
			// Give UI5 two frames to apply the visibility/layout change before measuring.
			schedule(function() {
				schedule(scrollWhenVisible);
			});
		},

		onExportDetailTable: function() {
			// Flatten all expanded tree levels so collapsed GR detail rows are included in Excel.
			var rows = [];

			function appendTreeRows(nodes) {
				(nodes || []).forEach(function(node) {
					var row = Object.assign({}, node);
					delete row.children;
					delete row._poNodes;
					delete row._grNodes;
					rows.push(row);
					appendTreeRows(node.children);
				});
			}
			appendTreeRows(this.getView().getModel("detail").getProperty("/visibleTreeRows"));
			if (!rows.length) {
				this._showMessage("There are no detail rows to export for the current filter.", "Information", false);
				return;
			}
			var EdmType = exportLibrary.EdmType;
			var columns = [{
				label: "Level",
				property: "NodeType",
				type: EdmType.String
			}, {
				label: "PR / PO / GR Item",
				property: "NodeLabel",
				type: EdmType.String
			}, {
				label: "PR Number",
				property: "banfn",
				type: EdmType.String
			}, {
				label: "PR Item",
				property: "bnfpo",
				type: EdmType.String
			}, {
				label: "Plant",
				property: "werks",
				type: EdmType.String
			}, {
				label: "PR Date",
				property: "BadatText",
				type: EdmType.String
			}, {
				label: "PR Release Date",
				property: "PRReleaseText",
				type: EdmType.String
			}, {
				label: "Requester",
				property: "afnam_pr",
				type: EdmType.String
			}, {
				label: "Cost Center",
				property: "kostl_pr",
				type: EdmType.String
			}, {
				label: "G/L Account",
				property: "sakto_pr",
				type: EdmType.String
			}, {
				label: "Purchase Group",
				property: "ekgrp",
				type: EdmType.String
			}, {
				label: "Vendor",
				property: "name1",
				type: EdmType.String
			}, {
				label: "Vendor Number",
				property: "lifnr",
				type: EdmType.String
			}, {
				label: "Currency",
				property: "Currency",
				type: EdmType.String
			}, {
				label: "PR Description",
				property: "TXZ01",
				type: EdmType.String
			}, {
				label: "Material",
				property: "matnr",
				type: EdmType.String
			}, {
				label: "PO Number",
				property: "ebeln",
				type: EdmType.String
			}, {
				label: "PO Item",
				property: "ebelp",
				type: EdmType.String
			}, {
				label: "Status",
				property: "Status",
				type: EdmType.String
			}, {
				label: "PO Created",
				property: "PODateText",
				type: EdmType.String
			}, {
				label: "PO Release",
				property: "POReleaseText",
				type: EdmType.String
			}, {
				label: "Delivery Date",
				property: "DeliveryText",
				type: EdmType.String
			}, {
				label: "PR Quantity",
				property: "PRQtyValue",
				type: EdmType.Number
			}, {
				label: "PR UOM",
				property: "meins_pr",
				type: EdmType.String
			}, {
				label: "PO Quantity",
				property: "POQtyValue",
				type: EdmType.Number
			}, {
				label: "PO UOM",
				property: "meins_po",
				type: EdmType.String
			}, {
				label: "GR Quantity",
				property: "GRQtyValue",
				type: EdmType.Number
			}, {
				label: "GR UOM",
				property: "gr_meins",
				type: EdmType.String
			}, {
				label: "Pending Quantity",
				property: "PendingQtyValue",
				type: EdmType.Number
			}, {
				label: "PR Unit Price (Lakh)",
				property: "UnitPriceLakhValue",
				type: EdmType.Number
			}, {
				label: "PR Total Value (Lakh)",
				property: "PRValueLakhValue",
				type: EdmType.Number
			}, {
				label: "GR Document",
				property: "mblnr",
				type: EdmType.String
			}, {
				label: "GR Year",
				property: "mjahr",
				type: EdmType.String
			}, {
				label: "GR Item",
				property: "ZEILE",
				type: EdmType.String
			}, {
				label: "GR Date",
				property: "GRDateText",
				type: EdmType.String
			}, {
				label: "PR – PO Days",
				property: "days_between_pr_po",
				type: EdmType.Number
			}];
			var spreadsheet = new Spreadsheet({
				workbook: {
					columns: columns,
					context: {
						sheetName: "PR PO GR Details"
					}
				},
				dataSource: rows,
				fileName: "PR_PO_GR_Details.xlsx"
			});
			spreadsheet.build().then(function() {
				spreadsheet.destroy();
			}.bind(this), function(error) {
				spreadsheet.destroy();
				this._logError("Detail Excel export failed", error);
				this._showMessage("Could not export the detail rows to Excel.", "Error", false);
			}.bind(this));
		},

		_scrollDetailsPanelIntoView: function() {
			var detailsPanel = this.byId("detailsPanel");
			var page = this.byId("page");
			if (!detailsPanel) {
				return;
			}
			// Wait for the panel's expand animation, then scroll the SAPUI5 Page scroller (not the window).
			setTimeout(function() {
				var domRef = detailsPanel.getDomRef();
				var pageDom = page && page.getDomRef();
				var pageScroller = pageDom && pageDom.querySelector(".sapMPageEnableScrolling");
				if (domRef && pageScroller && page && page.scrollTo) {
					var targetTop = pageScroller.scrollTop + domRef.getBoundingClientRect().top - pageScroller.getBoundingClientRect().top;
					page.scrollTo(Math.max(0, targetTop), 350);
					// Give keyboard and screen-reader focus to the newly opened dashboard.
					if (detailsPanel.focus) {
						setTimeout(function() {
							detailsPanel.focus();
						}, 380);
					}
				} else if (domRef && domRef.scrollIntoView) {
					domRef.scrollIntoView({
						behavior: "smooth",
						block: "start"
					});
				}
			}, 350);
		},

		/*
		 * DETAIL DASHBOARD FORMULA REFERENCE
		 * ----------------------------------
		 * Counting unit: one distinct PR item (banfn + bnfpo), not one PR number and
		 * not one GR posting. Repeated GR document items (mblnr + mjahr + ZEILE) are
		 * deduplicated and their received quantities are summed onto the PR item.
		 *
		 * Status per PR item (_detailStatus):
		 *   No PO Yet       = PO number (ebeln) is blank.
		 *   PO-Awaiting GR  = PO exists, pending_qty > 0, and summed GR quantity = 0.
		 *   PO-GR Partial   = PO exists, pending_qty > 0, and summed GR quantity > 0.
		 *   Fully Received  = PO exists and pending_qty = 0.
		 *   Over-Received   = PO exists and pending_qty < 0 (omitted from pipeline chart).
		 *   Pending Unknown = PO exists and pending_qty is missing.
		 *
		 * KPI formulas (_buildDetailDashboard):
		 *   PR Lines        = count of distinct PR items.
		 *   Total PR Value  = sum of PR total value once per distinct PR item.
		 *   PO Coverage     = No PO Yet PR items / all distinct PR items * 100.
		 *   Fully Received  = count of PR items with PO and pending_qty = 0.
		 *   Open PR         = count of PR items with PO and pending_qty > 0.
		 *   Value Pending PO= sum(pending_qty * unit price) for PO items with pending_qty > 0.
		 *
		 * Chart formulas:
		 *   Procurement Pipeline = distinct PR-item count by status; excludes Over-Received.
		 *   PR–PO Lead Time       = distinct PO-backed PR-item count in each day bucket.
		 *   Monthly PR Value      = sum(PR total value) by PR creation month and status;
		 *                           monetary charts divide by 100,000 when displayed in lakhs.
		 *   Top Vendors           = sum(PR total value) by vendor, descending, top ten.
		 *
		 * These are dashboard business definitions. Keep their calculation methods below
		 * aligned with this reference when changing the counting unit or status rules.
		 */
		_buildDetailDashboard: function(sourceRows) {
			var rows = sourceRows.map(function(record, index) {
				var copy = Object.assign({}, record);
				copy._rowIndex = index;
				copy.PRQtyValue = this._detailNumber(record.menge_pr);
				copy.POQtyValue = this._detailNumber(record.menge_po);
				copy.GRQtyValue = this._detailNumber(record.gr_menge);
				copy.PendingQtyValue = this._detailNumber(record.pending_qty);
				copy.PRValue = this._detailNumber(record.rlwrt_pr);
				copy.UnitPriceValue = this._detailNumber(record.preis_pr);
				copy.LeadDaysValue = this._detailNumber(record.days_between_pr_po);
				copy.Currency = String(record.waers_pr || "").trim().toUpperCase();
				copy.UnitPriceLakhValue = copy.UnitPriceValue === null ? null : copy.UnitPriceValue / 100000;
				copy.PRValueLakhValue = copy.PRValue === null ? null : copy.PRValue / 100000;
				copy.BadatText = this._formatDetailDate(record.badat_pr);
				copy.PODateText = this._formatDetailDate(record.aedat_po);
				copy.POReleaseText = this._formatDetailDate(record.release_date);
				copy.PRReleaseText = this._formatDetailDate(record.FRGDT);
				copy.DeliveryText = this._formatDetailDate(record.eindt);
				copy.GRDateText = this._formatDetailDate(record.gr_date);
				copy.PRLineKey = String(record.banfn || "") + "|" + String(record.bnfpo || "") + (record.banfn || record.bnfpo ? "" : "|" +
					index);
				copy.PRQtyText = this._formatQuantity(copy.PRQtyValue, record.meins_pr);
				copy.POQtyText = this._formatQuantity(copy.POQtyValue, record.meins_po);
				copy.GRQtyText = this._formatQuantity(copy.GRQtyValue, record.gr_meins);
				copy.PendingQtyText = this._formatQuantity(copy.PendingQtyValue, record.meins_po);
				copy.PRUnitPriceText = this._formatDetailCurrency(copy.UnitPriceValue, copy.Currency, 4);
				copy.PRTotalValueText = this._formatDetailCurrency(copy.PRValue, copy.Currency);
				copy.GRDocItemText = [record.mjahr, record.ZEILE].filter(function(value) {
					return !this._isBlank(value);
				}.bind(this)).join(" / ");
				return copy;
			}.bind(this));
			// KPI and chart formulas use one record per PR item, so repeated GR rows do not inflate totals.
			var lines = this._aggregateDetailPRLines(rows);
			var statusByPRLine = {};
			lines.forEach(function(line) {
				statusByPRLine[line.PRLineKey] = line.Status;
			});
			rows.forEach(function(row) {
				row.Status = statusByPRLine[row.PRLineKey] || "Pending Unknown";
				row.StatusState = this._detailStatusState(row.Status);
			}.bind(this));
			var pipeline = this._buildProcurementPipeline(lines);
			var leadTime = this._buildLeadTimeDistribution(lines);
			var currencies = [];
			lines.forEach(function(line) {
				var hasMonetaryInput = line.PRValue !== null || (!line.POBlank && line.PendingQtyValue > 0 && line.UnitPriceValue !== null);
				if (line.Currency && hasMonetaryInput && currencies.indexOf(line.Currency) === -1) {
					currencies.push(line.Currency);
				}
			});
			var singleCurrency = currencies.length === 1 ? currencies[0] : "";
			var valueWarnings = [];
			if (currencies.length > 1) {
				valueWarnings.push("Value charts are unavailable because the selected period contains multiple currencies (" + currencies.join(
					", ") + ").");
			}
			if (lines.some(function(line) {
					return !line.Currency && (line.PRValue !== null || line.PendingQtyValue > 0);
				})) {
				valueWarnings.push("Some lines have no currency. Monetary totals include only rows with a currency code.");
			}
			if (lines.some(function(line) {
					return !line.POBlank && line.PendingQtyValue > 0 && line.UnitPriceValue === null;
				})) {
				valueWarnings.push("Some open PR lines have no unit price and are excluded from Value Pending PO.");
			}
			var valueWarning = valueWarnings.join(" ");
			// Convert rupees to lakhs for monetary charts; retain the source unit if currency is unknown.
			var valueScale = singleCurrency ? 100000 : 1;
			var valueUnit = singleCurrency ? (singleCurrency === "INR" ? "₹ Lakh" : singleCurrency + " Lakh") : "";
			var monthlyValue = singleCurrency ? this._buildMonthlyValueByStatus(lines, singleCurrency, valueScale) : [];
			var topVendors = singleCurrency ? this._buildTopVendors(lines, singleCurrency, valueScale) : [];
			// Sum PR item values and open-PO pending values only for a single known currency.
			var totalPRValue = singleCurrency ? this._sumLineValues(lines, singleCurrency, false) : null;
			var pendingPOValue = singleCurrency ? this._sumLineValues(lines, singleCurrency, true) : null;
			// Count blank-PO items; PO Coverage follows the requested definition as the share without a PO.
			var noPOCount = lines.filter(function(line) {
				return line.POBlank;
			}).length;
			var openPRCount = lines.filter(function(line) {
				return !line.POBlank && line.PendingQtyValue !== null && line.PendingQtyValue > 0;
			}).length;
			var fullyReceivedCount = lines.filter(function(line) {
				return !line.POBlank && line.PendingQtyValue === 0;
			}).length;
			// PO Coverage (%) = PR items with blank PO / all distinct PR items × 100.
			var noPORate = lines.length ? (noPOCount / lines.length) * 100 : 0;
			var kpis = [
				this._kpi("PR Lines", this._formatInteger(lines.length), "Distinct PR number and item", "sap-icon://document-text", lines.length,
					"", "ALL"),
				this._kpi("Total PR Value", totalPRValue === null ? "—" : this._formatCurrency(totalPRValue, singleCurrency),
					"Sum of PR total price", "sap-icon://money-bills", totalPRValue, "", "PR_VALUE"),
				this._kpi("PO Coverage", noPORate.toFixed(1), "PR lines with blank PO", "sap-icon://chain-link", noPORate, "%", "PO_COVERAGE"),
				this._kpi("Fully Received", this._formatInteger(fullyReceivedCount), "PO present and pending quantity = 0", "sap-icon://accept",
					fullyReceivedCount, "", "FULLY_RECEIVED"),
				this._kpi("Open PR", this._formatInteger(openPRCount), "PO present and pending quantity > 0", "sap-icon://pending", openPRCount,
					"", "OPEN_PR"),
				this._kpi("Value Pending PO", pendingPOValue === null ? "—" : this._formatCurrency(pendingPOValue, singleCurrency),
					"Pending quantity × unit price", "sap-icon://money-bills", pendingPOValue, "", "VALUE_PENDING")
			];
			return {
				rows: rows,
				kpis: kpis,
				pipeline: pipeline,
				leadTime: leadTime,
				monthlyValue: monthlyValue,
				topVendors: topVendors,
				monthlyChartTitle: "Monthly PR Value by Status" + (valueUnit ? " (" + valueUnit + ")" : ""),
				topVendorsChartTitle: "Top Vendors – PR Value" + (valueUnit ? " (" + valueUnit + ")" : ""),
				valueWarningText: valueWarning
			};
		},

		_kpi: function(label, value, hint, icon, rawValue, unit, filterKey) {
			return {
				label: label,
				value: value,
				hint: hint,
				icon: icon,
				rawValue: rawValue,
				unit: unit || "",
				filterKey: filterKey || "ALL"
			};
		},

		_aggregateDetailPRLines: function(rows) {
			var byKey = {};
			var lines = [];
			rows.forEach(function(row) {
				var line = byKey[row.PRLineKey];
				if (!line) {
					line = Object.assign({}, row, {
						TotalGRQty: 0,
						_grDocumentKeys: {}
					});
					byKey[row.PRLineKey] = line;
					lines.push(line);
				}
				// Add each goods-receipt document item once, even if the backend repeats it.
				var grKey = [row.mblnr, row.mjahr, row.ZEILE].join("|");
				if (this._isBlank(row.mblnr) && this._isBlank(row.mjahr)) {
					grKey += row._rowIndex;
				}
				if (row.GRQtyValue !== null && !line._grDocumentKeys[grKey]) {
					line.TotalGRQty += row.GRQtyValue;
					line._grDocumentKeys[grKey] = true;
				}
			}.bind(this));
			lines.forEach(function(line) {
				line.POBlank = this._isBlank(line.ebeln);
				line.Status = this._detailStatus(line);
				delete line._grDocumentKeys;
			}.bind(this));
			return lines;
		},

		_detailStatus: function(line) {
			// Classify each PR item from PO presence, pending quantity, and received quantity.
			if (line.POBlank) {
				return "No PO Yet";
			}
			if (line.PendingQtyValue === null) {
				return "Pending Unknown";
			}
			if (line.PendingQtyValue < 0) {
				return "Over-Received";
			}
			if (line.PendingQtyValue === 0) {
				return "Fully Received";
			}
			if (line.TotalGRQty > 0) {
				return "PO-GR Partial";
			}
			return "PO-Awaiting GR";
		},

		_detailStatusState: function(status) {
			if (status === "Fully Received") {
				return "Success";
			}
			if (status === "PO-Awaiting GR") {
				// Use the dedicated CSS pill color instead of the default UI5 warning orange.
				return "None";
			}
			if (status === "PO-GR Partial") {
				return "Warning";
			}
			if (status === "No PO Yet" || status === "Over-Received") {
				return "Error";
			}
			return "None";
		},

		_buildProcurementPipeline: function(lines) {
			// Pipeline shows the requested PO progress statuses; over-received and IR remain omitted.
			var includedStatuses = ["No PO Yet", "PO-Awaiting GR", "PO-GR Partial", "Fully Received"];
			return includedStatuses.map(function(status) {
				return {
					Status: status,
					PRLines: lines.filter(function(line) {
						return line.Status === status;
					}).length
				};
			});
		},

		onDetailTableFilter: function() {
			var table = this.byId("detailsTable");
			var binding = table.getBinding("rows");
			if (!binding) {
				return;
			}
			var contexts = binding.getContexts(0, binding.getLength());
			var lineKeys = {};
			contexts.forEach(function(context) {
				var row = context.getObject();
				lineKeys[row.PRLineKey] = true;
			});
			var model = this.getView().getModel("detail");
			var activeKpi = model.getProperty("/activeKpiText");
			var summary = contexts.length + " detail rows · " + Object.keys(lineKeys).length + " PR items";
			model.setProperty("/tableSummaryText", activeKpi ? activeKpi + " · " + summary : summary);
			var hasColumnFilters = table.getColumns().some(function(column) {
				return column.getFiltered();
			});
			model.setProperty("/hasTableFilters", !!model.getProperty("/activeKpi") || !!model.getProperty("/searchQuery") || hasColumnFilters);
		},

		_buildLeadTimeDistribution: function(lines) {
			// Count PO-backed PR items into non-overlapping PR-to-PO day ranges.
			var buckets = [{
				Bucket: "0–3 d",
				Min: 0,
				Max: 3,
				PRLines: 0
			}, {
				Bucket: "4–7 d",
				Min: 4,
				Max: 7,
				PRLines: 0
			}, {
				Bucket: "8–15 d",
				Min: 8,
				Max: 15,
				PRLines: 0
			}, {
				Bucket: "16–30 d",
				Min: 16,
				Max: 30,
				PRLines: 0
			}, {
				Bucket: "31–60 d",
				Min: 31,
				Max: 60,
				PRLines: 0
			}, {
				Bucket: "60+ d",
				Min: 61,
				Max: Number.MAX_VALUE,
				PRLines: 0
			}];
			lines.forEach(function(line) {
				if (line.POBlank || line.LeadDaysValue === null || line.LeadDaysValue < 0) {
					return;
				}
				var bucket = buckets.filter(function(item) {
					return line.LeadDaysValue >= item.Min && line.LeadDaysValue <= item.Max;
				})[0];
				if (bucket) {
					bucket.PRLines += 1;
				}
			});
			return buckets;
		},

		_buildMonthlyValueByStatus: function(lines, currency, valueScale) {
			// Sum PR value by PR creation month and status, converting each amount to lakhs.
			var byMonth = {};
			lines.forEach(function(line) {
				if (!line.BadatText || !line.Currency || line.Currency !== currency || line.PRValue === null) {
					return;
				}
				var date = this._dateValue(line.badat_pr);
				if (!date) {
					return;
				}
				var monthKey = date.getFullYear() * 100 + date.getMonth();
				if (!byMonth[monthKey]) {
					byMonth[monthKey] = {
						Month: MONTHS_SHORT[date.getMonth()] + " " + date.getFullYear(),
						SortKey: monthKey,
						NoPOYetValue: 0,
						POAwaitingGRValue: 0,
						POGRPartialValue: 0,
						FullyReceivedValue: 0
					};
				}
				var field = {
					"No PO Yet": "NoPOYetValue",
					"PO-Awaiting GR": "POAwaitingGRValue",
					"PO-GR Partial": "POGRPartialValue",
					"Fully Received": "FullyReceivedValue"
				}[line.Status];
				if (field) {
					byMonth[monthKey][field] += line.PRValue / valueScale;
				}
			}.bind(this));
			return Object.keys(byMonth).map(function(key) {
				return byMonth[key];
			}).sort(function(a, b) {
				return a.SortKey - b.SortKey;
			});
		},

		_buildTopVendors: function(lines, currency, valueScale) {
			// Rank vendors by summed PR item value in lakhs, then keep the top ten.
			var vendors = {};
			lines.forEach(function(line) {
				if (!line.Currency || line.Currency !== currency || line.PRValue === null) {
					return;
				}
				var key = String(line.lifnr || line.name1 || "Unknown vendor").trim();
				if (!vendors[key]) {
					vendors[key] = {
						Vendor: String(line.name1 || line.lifnr || "Unknown vendor").trim(),
						PRValue: 0
					};
				}
				vendors[key].PRValue += line.PRValue / valueScale;
			});
			return Object.keys(vendors).map(function(key) {
					return vendors[key];
				})
				.sort(function(a, b) {
					return b.PRValue - a.PRValue;
				}).slice(0, 10);
		},

		_sumLineValues: function(lines, currency, pendingOnly) {
			// Total PR Value sums item values; Value Pending PO sums pending quantity × unit price for open PO items.
			var total = 0;
			lines.forEach(function(line) {
				if (pendingOnly) {
					if (!line.POBlank && line.PendingQtyValue > 0 && line.Currency === currency) {
						total += this._calculateValuePendingPO(line);
					}
				} else if (line.Currency === currency && line.PRValue !== null) {
					total += line.PRValue;
				}
			}.bind(this));
			return total;
		},

		_calculateValuePendingPO: function(line) {
			// Pending PO value = positive pending quantity × unit price; invalid or non-open items contribute zero.
			if (line.POBlank || line.PendingQtyValue === null || line.PendingQtyValue <= 0 || line.UnitPriceValue === null) {
				return 0;
			}
			return line.PendingQtyValue * line.UnitPriceValue;
		},

		_detailNumber: function(value) {
			if (value === null || value === undefined || String(value).trim() === "") {
				return null;
			}
			var number = Number(String(value).trim().replace(/,/g, ""));
			return isFinite(number) ? number : null;
		},

		_isBlank: function(value) {
			return value === null || value === undefined || String(value).trim() === "";
		},

		_formatInteger: function(value) {
			return new Intl.NumberFormat("en-IN", {
				maximumFractionDigits: 0
			}).format(value || 0);
		},

		_formatQuantity: function(value, unit) {
			if (value === null || value === undefined) {
				return "";
			}
			var formatted = new Intl.NumberFormat("en-IN", {
				maximumFractionDigits: 3
			}).format(value);
			return formatted + (unit ? " " + unit : "");
		},

		_formatDetailCurrency: function(value, currency, precision) {
			if (value === null || value === undefined) {
				return "";
			}
			// Display backend currency amounts in lakhs (1 lakh = 100,000 currency units).
			var lakhs = (value / 100000).toFixed(precision === undefined ? 2 : precision);
			return (currency === "INR" ? "₹" : (currency ? currency + " " : "")) + lakhs + " L";
		},

		_formatCurrency: function(value, currency) {
			if (!currency || value === null || value === undefined) {
				return "—";
			}
			// KPI currency formula: source amount ÷ 100,000, rounded for readable lakh display.
			var lakhValue = value / 100000;
			var precision = Math.abs(lakhValue) < 0.1 && lakhValue !== 0 ? 4 : 2;
			var lakhs = lakhValue.toFixed(precision);
			return (currency === "INR" ? "₹" : currency + " ") + lakhs + " L";
		},

		_dateValue: function(value) {
			if (value === null || value === undefined || String(value).trim() === "") {
				return null;
			}
			if (value instanceof Date && !isNaN(value.getTime())) {
				return value;
			}
			var dateMatch = /\/Date\((-?\d+)\)\//.exec(String(value || ""));
			if (dateMatch) {
				return new Date(parseInt(dateMatch[1], 10));
			}
			var parts = this._parseYmd(value);
			if (parts) {
				return new Date(parts.y, parts.m - 1, parts.d);
			}
			var parsed = new Date(value);
			return isNaN(parsed.getTime()) ? null : parsed;
		},

		_formatDetailDate: function(value) {
			var date = this._dateValue(value);
			return date ? ("0" + date.getDate()).slice(-2) + " " + MONTHS_SHORT[date.getMonth()] + " " + date.getFullYear() : "";
		},

		_processPeriodWiseResponse: function(response, reportType) {
			if (!response || !Array.isArray(response.results)) {
				throw new Error("Unexpected PRPOGRN_QuantitySet response structure.");
			}
			var periods = response.results.map(function(record, index) {
				var from = this._parseYmd(record.FromDate);
				var to = this._parseYmd(record.ToDate);
				return {
					id: [record.Werks, record.FromDate, record.ToDate].join("|"),
					Werks: record.Werks || "",
					Year: record.Year || (from ? String(from.y) : ""),
					period: this._periodLabel(record, reportType, from, to),
					FromDate: record.FromDate || "", // raw yyyyMMdd – use for the detail request
					ToDate: record.ToDate || "",
					FromText: this._formatYmd(from, record.FromDate),
					ToText: this._formatYmd(to, record.ToDate),
					RangeText: this._formatYmd(from, record.FromDate) + " – " + this._formatYmd(to, record.ToDate),
					PRQty: this._safeNumber(record.PRQty),
					POQty: this._safeNumber(record.POQty),
					GRNQty: this._safeNumber(record.GRNQty),
					_index: index
				};
			}.bind(this));

			periods.sort(function(a, b) {
				return this._dateSort(a.FromDate) - this._dateSort(b.FromDate) || a._index - b._index;
			}.bind(this));
			periods.forEach(function(period) {
				delete period._index;
			});

			this._logInfo("Response processed", {
				rawCount: response.results.length,
				processedResponse: periods
			});
			return periods;
		},

		_periodLabel: function(record, reportType, from, to) {
			var year = from ? from.y : parseInt(record.Year, 10);
			var month = from ? from.m : (parseInt(record.Month, 10) || NaN);
			var monthRange = !!(from && to && from.y === to.y && from.m === to.m && from.d === 1 &&
				to.d === new Date(to.y, to.m, 0).getDate());
			var quarterRange = !!(from && to && from.y === to.y && from.d === 1 && [1, 4, 7, 10].indexOf(from.m) !== -1 && to.m === from.m + 2 &&
				to.d === new Date(to.y, to.m, 0).getDate());
			var yearRange = !!(from && to && from.y === to.y && from.m === 1 && from.d === 1 && to.m === 12 && to.d === 31);

			// Some backend responses contain several month rows with the same Quarter/Year
			// field. Use each row's date range so the chart gets a distinct category per row.
			if (monthRange || reportType === "M") {
				return month >= 1 && month <= 12 ? MONTHS_SHORT[month - 1] + " " + year : String(record.Month || "(Period unavailable)");
			}
			if (quarterRange) {
				return "Q" + Math.ceil(from.m / 3) + " " + year;
			}
			if (yearRange || reportType === "Y" && !from) {
				return String(year || record.Year || "(Period unavailable)");
			}
			if (from && to) {
				return this._formatYmd(from, record.FromDate) + " – " + this._formatYmd(to, record.ToDate);
			}
			if (reportType === "Q") {
				var match = /(\d)/.exec(String(record.Quarter || ""));
				return match ? "Q" + match[1] + " " + (year || record.Year) : "(Period unavailable)";
			}
			return String(year || record.Year || "(Period unavailable)");
		},

		_parseYmd: function(value) {
			var match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(value || "").trim());
			return match ? {
				y: parseInt(match[1], 10),
				m: parseInt(match[2], 10),
				d: parseInt(match[3], 10)
			} : null;
		},

		_formatYmd: function(parts, fallback) {
			if (!parts || parts.m < 1 || parts.m > 12) {
				return String(fallback || "");
			}
			return ("0" + parts.d).slice(-2) + " " + MONTHS_SHORT[parts.m - 1] + " " + parts.y;
		},

		_dateSort: function(value) {
			var parts = this._parseYmd(value);
			return parts ? parts.y * 10000 + parts.m * 100 + parts.d : Number.MAX_SAFE_INTEGER;
		},

		_safeNumber: function(value) {
			if (value === null || value === undefined || String(value).trim() === "") {
				return 0;
			}
			var number = Number(String(value).trim()); // backend sends " 2.000"
			if (!isFinite(number)) {
				this._logWarn("Invalid numeric quantity", {
					value: value
				});
				return 0;
			}
			return Math.round(number);
		},

		/* =========================================================== */
		/* Chart / table selection (kept in sync)                      */
		/* =========================================================== */
		_configureChart: function() {
			this.byId("quantityChart").setVizProperties({
				title: {
					visible: false
				},
				plotArea: {
					colorPalette: SERIES_COLORS,
					dataPointSize: {
						min: 12,
						max: 28
					},
					gap: {
						innerGroupSpacing: 0.15
					},
					dataLabel: {
						visible: true,
						formatString: "#,##0",
						hideWhenOverlap: false
					},
					gridline: {
						visible: true
					}
				},
				valueAxis: {
					title: {
						visible: true,
						text: "Quantity"
					},
					label: {
						formatString: "#,##0"
					}
				},
				categoryAxis: {
					title: {
						visible: false
					}
				},
				legend: {
					visible: false
				},
				interaction: {
					selectability: {
						mode: "SINGLE"
					}
				}
			});
		},

		_configureDetailCharts: function() {
			var pipeline = this.byId("detailPipelineChart");
			var leadTime = this.byId("detailLeadTimeChart");
			var monthlyValue = this.byId("detailMonthlyValueChart");
			var topVendors = this.byId("detailTopVendorsChart");
			var common = {
				title: {
					visible: false
				},
				plotArea: {
					dataLabel: {
						visible: true,
						hideWhenOverlap: false,
						formatString: "#,##0"
					},
					gridline: {
						visible: true
					}
				},
				valueAxis: {
					title: {
						visible: false
					},
					label: {
						formatString: "#,##0"
					}
				},
				categoryAxis: {
					title: {
						visible: false
					}
				},
				legend: {
					visible: false
				},
				interaction: {
					selectability: {
						mode: "SINGLE"
					}
				}
			};
			var propertiesWithPalette = function(palette) {
				return {
					title: common.title,
					plotArea: Object.assign({}, common.plotArea, {
						colorPalette: palette
					}),
					valueAxis: common.valueAxis,
					categoryAxis: common.categoryAxis,
					legend: common.legend,
					interaction: common.interaction
				};
			};
			var pipelineProperties = propertiesWithPalette(["#f04b50", "#e9730c", "#1680f5", "#14a65a"]);
			pipelineProperties.plotArea.dataPointStyle = {
				rules: [{
					dataContext: {
						Status: "No PO Yet"
					},
					properties: {
						color: "#f04b50"
					}
				}, {
					dataContext: {
						Status: "PO-Awaiting GR"
					},
					properties: {
						color: "#e9730c"
					}
				}, {
					dataContext: {
						Status: "PO-GR Partial"
					},
					properties: {
						color: "#1680f5"
					}
				}, {
					dataContext: {
						Status: "Fully Received"
					},
					properties: {
						color: "#14a65a"
					}
				}]
			};
			pipeline.setVizProperties(pipelineProperties);
			leadTime.setVizProperties(propertiesWithPalette(["#7c3aed"]));
			var topVendorsProperties = propertiesWithPalette(["#087df5"]);
			topVendorsProperties.plotArea.dataLabel.formatString = "#,##0.0###";
			topVendorsProperties.valueAxis.label.formatString = "#,##0.0###";
			topVendors.setVizProperties(topVendorsProperties);
			monthlyValue.setVizProperties({
				title: {
					visible: false
				},
				plotArea: {
					colorPalette: ["#d55e00", "#e69f00", "#cc79a7", "#bf2a5e"],
					dataLabel: {
						visible: true,
						hideWhenOverlap: false,
						formatString: "#,##0.0###"
					},
					gridline: {
						visible: true
					}
				},
				valueAxis: {
					title: {
						visible: false
					},
					label: {
						formatString: "#,##0.0###"
					}
				},
				categoryAxis: {
					title: {
						visible: false
					}
				},
				legend: {
					visible: false
				},
				interaction: {
					selectability: {
						mode: "SINGLE"
					}
				}
			});
		},

		onDetailChartRenderComplete: function(event) {
			this._connectChartPopover(event.getSource());
		},

		onChartRenderComplete: function(event) {
			this._connectChartPopover(event.getSource());
			if (!this._fitChartPending) {
				return;
			}
			this._fitChartPending = false;
			var chart = this.byId("quantityChart");
			if (!chart) {
				return;
			}
			// ChartContainer zoom can leave a previous horizontal zoom window active.
			// Zoom out to the fit-to-data view whenever a new response is rendered.
			for (var i = 0; i < 10; i += 1) {
				chart.zoom({
					direction: "out"
				});
			}
		},

		onChartSelect: function(event) {
			if (this._syncing) {
				return;
			}
			var data = event.getParameter("data") || [];
			if (!data.length) {
				return;
			}
			var values = data[0].data;
			var periodLabel;
			if (Array.isArray(values)) {
				values.forEach(function(entry) {
					if (entry.name === "Period") {
						periodLabel = entry.value;
					}
				});
			} else if (values) {
				periodLabel = values.Period;
			}
			var match = (this.getView().getModel("screen1").getProperty("/periods") || []).filter(function(row) {
				return row.period === periodLabel;
			})[0];
			if (match) {
				this._selectPeriod(match.id, "chart");
			} else {
				this._logWarn("Chart selection did not match a period", {
					periodLabel: periodLabel
				});
			}
		},

		onTableSelect: function(event) {
			if (this._syncing) {
				return;
			}
			var item = event.getParameter("listItem");
			if (item) {
				this._selectPeriod(item.getBindingContext("screen1").getProperty("id"), "table");
			}
		},

		_selectPeriod: function(periodId, source) {
			var vm = this.getView().getModel("screen1");
			var item = (vm.getProperty("/periods") || []).filter(function(row) {
				return row.id === periodId;
			})[0];
			if (!item) {
				return;
			}
			var current = vm.getProperty("/selectedPeriod");
			if (current && current.id === periodId && source !== "init") {
				return;
			}
			vm.setProperty("/selectedPeriod", item);
			this._syncing = true;
			try {
				if (source !== "table") {
					this._selectTableRow(periodId);
				}
				if (source !== "chart") {
					this._highlightChart(item.period);
				}
			} finally {
				this._syncing = false;
			}
			this._logInfo("Selected period", {
				source: source,
				period: item
			});
			this._loadDetailsForPeriod(item);
		},

		_clearPeriodSelection: function() {
			var vm = this.getView().getModel("screen1");
			this._detailRequestSerial += 1;
			this._detailRetryPeriod = null;
			vm.setProperty("/selectedPeriod", null);
			var detailModel = this.getView().getModel("detail");
			if (detailModel) {
				detailModel.setData({
					selectedPeriod: null,
					contextText: "",
					viewMode: "graphical",
					busy: false,
					hasData: false,
					noData: false,
					errorText: "",
					valueWarningText: "",
					rows: [],
					visibleRows: [],
					visibleTreeRows: [],
					activeKpi: "",
					activeKpiText: "",
					searchQuery: "",
					hasTableFilters: false,
					tableSummaryText: "",
					kpis: [],
					pipeline: [],
					leadTime: [],
					monthlyValue: [],
					topVendors: []
				});
			}
			var detailsPanel = this.byId("detailsPanel");
			if (detailsPanel && detailsPanel.getExpanded()) {
				detailsPanel.setExpanded(false);
			}
			this._syncing = true;
			try {
				var table = this.byId("periodTable");
				if (table) {
					table.removeSelections(true);
				}
				var chart = this.byId("quantityChart");
				if (chart) {
					chart.vizSelection([], {
						clearSelection: true
					});
				}
			} catch (error) {
				this._logWarn("Could not clear prior period selection", error);
			} finally {
				this._syncing = false;
			}
		},

		_selectTableRow: function(periodId) {
			var table = this.byId("periodTable");
			table.getItems().some(function(row) {
				var match = row.getBindingContext("screen1").getProperty("id") === periodId;
				if (match) {
					table.setSelectedItem(row, true);
				}
				return match;
			});
		},

		_highlightChart: function(periodLabel) {
			try {
				this.byId("quantityChart").vizSelection([{
					data: {
						Period: periodLabel
					}
				}], {
					clearSelection: true
				});
			} catch (e) {
				this._logWarn("Chart highlight not applied", e);
			}
		},

		/* =========================================================== */
		/* Reset                                                       */
		/* =========================================================== */
		onReset: function() {
			var vm = this.getView().getModel("screen1");
			var now = new Date();
			this._requestSerial++; // invalidate any request still running
			this._retryAction = null;
			vm.setProperty("/selection", {
				plant: "",
				type: "M",
				year: String(now.getFullYear()),
				subPeriod: ""
			});
			this._clearPeriodSelection();
			vm.setProperty("/periods", []);
			vm.setProperty("/searched", false);
			vm.setProperty("/hasData", false);
			vm.setProperty("/showNoData", false);
			vm.setProperty("/hasError", false);
			vm.setProperty("/contextText", "");
			["plant", "year", "subPeriod"].forEach(function(field) {
				this._setFieldState(field, "None", "");
			}.bind(this));
			this._setBusy(false);
			this._updateSubPeriods(true);
			this._clearMessage();
			this._logInfo("Reset", {});
		},

		/* =========================================================== */
		/* Busy / messages / errors                                    */
		/* =========================================================== */
		_setBusy: function(busy) {
			this._requestPending = busy;
			this.getView().getModel("screen1").setProperty("/busy", busy);
		},

		_handleODataError: function(error, context, fallback, retryAction) {
			var parsed = this._parseError(error, fallback);
			this._retryAction = retryAction || null;
			this._logError(context, {
				status: parsed.status,
				message: parsed.message,
				details: error && error.responseText,
				raw: error
			});
			this._showMessage(parsed.message, "Error", !!retryAction);
		},

		_parseError: function(error, fallback) {
			var status = error && error.statusCode ? parseInt(error.statusCode, 10) : 0;
			var raw = (error && error.responseText) || "";
			var message = "";
			try {
				message = JSON.parse(raw).error.message.value;
			} catch (e) {
				var xml = /<message[^>]*>([^<]+)<\/message>/i.exec(String(raw));
				message = xml ? xml[1] : "";
			}
			if (!message) {
				if (!status) {
					message = "Cannot reach the server. Check your connection and try again.";
				} else if (status === 401 || status === 403) {
					message = "You are not authorised to load this data (HTTP " + status + ").";
				} else if (status === 404) {
					message = "The service or data set was not found (HTTP 404). Check the service configuration.";
				} else if (status >= 500) {
					message = "The backend reported an error (HTTP " + status + "). Please try again later.";
				} else {
					message = fallback || "The request failed.";
				}
			}
			return {
				status: status,
				message: message
			};
		},

		_showMessage: function(message, type, canRetry) {
			var strip = this.byId("pageMessage");
			this.getView().getModel("screen1").setProperty("/canRetry", !!canRetry);
			strip.setText(message);
			strip.setType(type);
			strip.setVisible(true);
		},

		_clearMessage: function() {
			this.byId("pageMessage").setVisible(false);
			this.getView().getModel("screen1").setProperty("/canRetry", false);
		},

		/* =========================================================== */
		/* Logging                                                     */
		/* =========================================================== */
		_logInfo: function(event, details) {
			if (DEBUG && window.console) {
				window.console.info(LOG_PREFIX + event, details || {});
			}
		},
		_logWarn: function(event, details) {
			if (window.console) {
				window.console.warn(LOG_PREFIX + event, details || {});
			}
		},
		_logError: function(event, details) {
			if (window.console) {
				window.console.error(LOG_PREFIX + event, details || {});
			}
		}
	});
});
