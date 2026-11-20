sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/SelectDialog",
	"sap/m/StandardListItem",
	"sap/ui/Device",
	"sap/ui/model/type/Float" // preload only: used as a type in View1.view.xml (avoids a sync load)
], function(Controller, JSONModel, Filter, FilterOperator, SelectDialog, StandardListItem, Device) {
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

			// Chart sits in the left half of the analysis panel, so keep it compact
			var chartHeight = Device.system.phone ? "18rem" : (Device.system.tablet ? "20rem" : "22rem");

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
					type: "M",
					year: String(currentYear),
					subPeriod: String(now.getMonth() + 1)
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
					subPeriodLabel: "Month"
				}
			}), "screen1");

			this._updateSubPeriods(true);
			this._configureChart();
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
		onPlantChange: function() {
			this._setFieldState("plant", "None", "");
			this._markStale();
		},
		onYearChange: function() {
			this._setFieldState("year", "None", "");
			this._markStale();
		},
		onSubPeriodChange: function() {
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
			var now = new Date();
			var options = [];
			var defaultKey = "";
			if (type === "M") {
				options = MONTHS.map(function(text, i) {
					return {
						key: String(i + 1),
						text: text
					};
				});
				defaultKey = String(now.getMonth() + 1);
			} else if (type === "Q") {
				options = QUARTERS.map(function(text, i) {
					return {
						key: String(i + 1),
						text: text
					};
				});
				defaultKey = String(Math.floor(now.getMonth() / 3) + 1);
			}
			vm.setProperty("/subPeriods", options);
			vm.setProperty("/ui/subPeriodLabel", type === "Q" ? "Quarter" : "Month");
			if (resetToCurrent) {
				vm.setProperty("/selection/subPeriod", defaultKey);
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
				periodValid = (vm.getProperty("/subPeriods") || []).some(function(item) {
					return item.key === selection.subPeriod;
				});
				if (!periodValid) {
					var text = selection.type === "M" ? "Month is required for a monthly report." : "Quarter is required for a quarterly report.";
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
			vm.setProperty("/selectedPeriod", null);
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
				result.Month = ("0" + selection.subPeriod).slice(-2); // backend returns Month as "06"
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
				period = MONTHS[parseInt(selection.subPeriod, 10) - 1] + " " + selection.year;
			} else if (selection.type === "Q") {
				period = "Q" + selection.subPeriod + " " + selection.year;
			}
			return plantText + "  |  " + period;
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
					period: this._periodLabel(record, reportType, from),
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

		_periodLabel: function(record, reportType, from) {
			var year = record.Year || (from ? String(from.y) : "");
			var label;
			if (reportType === "M") {
				var month = parseInt(record.Month, 10) || (from ? from.m : NaN);
				label = isFinite(month) && month >= 1 && month <= 12 ? MONTHS[month - 1] + " " + year : String(record.Month || "");
			} else if (reportType === "Q") {
				var match = /(\d)/.exec(String(record.Quarter || ""));
				var quarter = match ? match[1] : (from ? String(Math.ceil(from.m / 3)) : "");
				label = quarter ? "Q" + quarter + " " + year : "";
			} else {
				label = String(year);
			}
			return label || "(Period unavailable)";
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
			return number;
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
					dataLabel: {
						visible: true,
						formatString: "#,##0.###"
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
						formatString: "#,##0.###"
					}
				},
				categoryAxis: {
					title: {
						visible: false
					}
				},
				legend: {
					visible: true,
					position: "top"
				},
				interaction: {
					selectability: {
						mode: "SINGLE"
					}
				}
			});
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
			// Hook for the detailed dashboard (next step): use item.Werks, item.FromDate, item.ToDate.
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
				subPeriod: String(now.getMonth() + 1)
			});
			vm.setProperty("/periods", []);
			vm.setProperty("/searched", false);
			vm.setProperty("/hasData", false);
			vm.setProperty("/showNoData", false);
			vm.setProperty("/hasError", false);
			vm.setProperty("/selectedPeriod", null);
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